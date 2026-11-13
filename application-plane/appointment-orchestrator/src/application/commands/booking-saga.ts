import { newId, type DatabaseClient } from '@medicitas/kernel';
import type { Logger } from '@medicitas/observability';
import {
  decide,
  failureReason,
  isTerminal,
  type BookingSaga,
  type PatientRequest,
  type StepName,
  type StepReply,
} from '../../domain/entities/booking-saga.js';
import { PgSagaRepository } from '../../infrastructure/persistence/pg-saga-repository.js';
import { enqueueBookingFailed, enqueueSagaCommand, stepPayload } from '../../infrastructure/messaging/saga-commands.js';

export interface SagaSettings {
  /** Deadline of the participant phase (15 s; shorter than the 60 s hold TTL). */
  readonly deadlineMs: number;
  /** Interval after which an unanswered command is re-sent with the SAME messageId. */
  readonly resendMs: number;
  /** How long a compensation may wait for the release reply before the saga fails anyway. */
  readonly compensationWindowMs: number;
}

export interface StartBookingInput {
  readonly patient: PatientRequest;
  readonly professionalId: string;
  readonly serviceId: string;
  readonly startAt: string;
  readonly actorSubject: string;
  readonly actorRole: 'clinic_admin' | 'receptionist';
  readonly correlationId: string;
  readonly tenantId: string;
}

/**
 * RF9 step 1–3: persist the saga and dispatch the three participant commands IN PARALLEL, all in
 * the same transaction (three outbox rows). The orchestrator generates sagaId, appointmentId and,
 * for a new patient, patientId, so every participant is idempotent by identifier.
 */
export async function startBooking(client: DatabaseClient, settings: SagaSettings, input: StartBookingInput): Promise<BookingSaga> {
  const repository = new PgSagaRepository(client);
  const sagaId = newId();
  const appointmentId = newId();
  await repository.insertSaga({
    id: sagaId,
    appointmentId,
    patientId: input.patient.patientId,
    professionalId: input.professionalId,
    serviceId: input.serviceId,
    startAt: input.startAt,
    patientMode: input.patient.mode,
    actorSubject: input.actorSubject,
    actorRole: input.actorRole,
    correlationId: input.correlationId,
    deadlineMs: settings.deadlineMs,
  });
  const saga = (await repository.findSaga(sagaId)) as BookingSaga;
  for (const step of ['patient', 'catalog', 'slot'] as const) {
    const command = await enqueueSagaCommand(client, saga, step, stepPayload(saga, step, input.patient));
    await repository.insertDispatchedStep(sagaId, step, command.messageId, settings.resendMs);
  }
  return saga;
}

async function dispatch(client: DatabaseClient, settings: SagaSettings, saga: BookingSaga, step: StepName, reasonCode?: string): Promise<void> {
  const command = await enqueueSagaCommand(client, saga, step, stepPayload(saga, step, null, reasonCode));
  await new PgSagaRepository(client).dispatchStep(saga.id, step, command.messageId, settings.resendMs);
}

/** Applies the aggregation rules until the saga has to wait for another reply. */
export async function advance(client: DatabaseClient, settings: SagaSettings, sagaId: string, logger: Logger): Promise<void> {
  const repository = new PgSagaRepository(client);
  const saga = await repository.findSaga(sagaId, { forUpdate: true });
  if (saga === null || isTerminal(saga.status)) return;
  const steps = await repository.steps(sagaId);
  const decision = decide(saga, steps);
  switch (decision.kind) {
    case 'wait':
      return;
    case 'confirm':
      await dispatch(client, settings, saga, 'confirm');
      await repository.updateSaga(saga.id, { status: 'confirming' });
      return;
    case 'complete':
      await repository.updateSaga(saga.id, { status: 'completed', result: decision.appointment });
      logger.info({ sagaId, appointmentId: saga.appointmentId }, 'booking saga completed');
      return;
    case 'compensate':
      await compensate(client, settings, saga, decision.errorCode);
      return;
    case 'fail':
      await fail(client, saga, decision.errorCode, logger);
      return;
  }
}

/** → COMPENSATING: release the slot (idempotent; a no-op if it was never held). */
export async function compensate(client: DatabaseClient, settings: SagaSettings, saga: BookingSaga, errorCode: string | null): Promise<void> {
  await dispatch(client, settings, saga, 'release', 'BOOKING_FAILED');
  await new PgSagaRepository(client).updateSaga(saga.id, {
    status: 'compensating',
    ...(errorCode === null ? {} : { errorCode, errorDetail: null }),
    deadlineMs: settings.compensationWindowMs,
  });
}

/** → FAILED with the most specific reason; announces AppointmentBookingFailed. */
export async function fail(client: DatabaseClient, saga: BookingSaga, errorCode: string | null, logger: Logger): Promise<void> {
  const repository = new PgSagaRepository(client);
  const reason = failureReason(await repository.steps(saga.id), errorCode ?? saga.errorCode);
  await repository.updateSaga(saga.id, {
    status: 'failed',
    result: Object.keys(reason.details).length === 0 ? null : { details: reason.details },
    errorCode: reason.code,
    errorDetail: reason.detail,
  });
  await enqueueBookingFailed(client, saga, reason.code);
  logger.info({ sagaId: saga.id, code: reason.code }, 'booking saga failed');
}

/**
 * Handles one participant reply (inside the inbox transaction). Stale replies (an older command id)
 * and duplicates are ignored. A hold that succeeds AFTER the saga gave up is released again.
 */
export async function applyReply(
  client: DatabaseClient,
  settings: SagaSettings,
  reply: { readonly sagaId: string; readonly step: StepName; readonly commandId: string; readonly payload: StepReply },
  logger: Logger,
): Promise<void> {
  const repository = new PgSagaRepository(client);
  const saga = await repository.findSaga(reply.sagaId, { forUpdate: true });
  if (saga === null) {
    logger.warn({ sagaId: reply.sagaId }, 'reply for an unknown saga ignored');
    return;
  }
  const step = (await repository.steps(saga.id)).find((candidate) => candidate.name === reply.step);
  if (step === undefined || step.commandMessageId !== reply.commandId || step.status !== 'dispatched') return;
  await repository.recordReply(saga.id, reply.step, reply.payload.outcome, reply.payload);

  const lateHold = reply.step === 'slot' && reply.payload.outcome === 'succeeded' && (saga.status === 'failed' || saga.status === 'compensating');
  if (lateHold) {
    // The release may have reached the scheduler before this hold committed: release again.
    await dispatch(client, settings, saga, 'release', 'BOOKING_FAILED');
    if (saga.status === 'failed') return;
  }
  if (isTerminal(saga.status)) return;
  await advance(client, settings, saga.id, logger);
}

/** Deadline handling (sweeper): participants silent → compensate; compensation silent → fail. */
export async function expire(client: DatabaseClient, settings: SagaSettings, sagaId: string, logger: Logger): Promise<void> {
  const repository = new PgSagaRepository(client);
  const saga = await repository.findSaga(sagaId, { forUpdate: true });
  if (saga === null || isTerminal(saga.status) || saga.deadlineAt.getTime() > Date.now()) return;
  if (saga.status === 'compensating') {
    // The scheduler's hold expiry releases the slot anyway (it can never stay blocked).
    await fail(client, saga, null, logger);
    return;
  }
  const errorCode = saga.status === 'confirming' ? 'BOOKING_INTERRUPTED' : 'DEPENDENCY_UNAVAILABLE';
  logger.warn({ sagaId, status: saga.status }, 'booking saga deadline reached; compensating');
  await compensate(client, settings, saga, errorCode);
}
