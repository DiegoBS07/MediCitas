import { newId, type DatabaseClient } from '@medicitas/kernel';
import { EXCHANGES, createEnvelope, enqueueOutbox, type Envelope } from '@medicitas/messaging';
import type { BookingSaga, PatientRequest, StepName } from '../../domain/entities/booking-saga.js';

const PRODUCER = 'appointment-orchestrator';

const ROUTES: Readonly<Record<StepName, { readonly messageType: string; readonly routingKey: string }>> = {
  patient: { messageType: 'EnsurePatientCommand', routingKey: 'user-management.patient.ensure' },
  catalog: { messageType: 'ValidateBookingCatalogCommand', routingKey: 'catalog-service-management.booking.validate' },
  slot: { messageType: 'HoldSlotCommand', routingKey: 'scheduler-management.slot.hold' },
  confirm: { messageType: 'ConfirmAppointmentCommand', routingKey: 'scheduler-management.slot.confirm' },
  release: { messageType: 'ReleaseSlotCommand', routingKey: 'scheduler-management.slot.release' },
};

/** Command payloads v1 (messaging-contracts §6), built from the persisted saga. */
export function stepPayload(
  saga: Pick<BookingSaga, 'appointmentId' | 'patientId' | 'professionalId' | 'serviceId' | 'startAt'>,
  step: StepName,
  patient: PatientRequest | null,
  reasonCode = 'BOOKING_FAILED',
): Readonly<Record<string, unknown>> {
  switch (step) {
    case 'patient':
      return patient ?? { mode: 'existing', patientId: saga.patientId };
    case 'catalog':
      return { professionalId: saga.professionalId, serviceId: saga.serviceId };
    case 'slot':
      return {
        appointmentId: saga.appointmentId,
        patientId: saga.patientId,
        professionalId: saga.professionalId,
        serviceId: saga.serviceId,
        startAt: saga.startAt.toISOString(),
      };
    case 'confirm':
      return { appointmentId: saga.appointmentId };
    case 'release':
      return { appointmentId: saga.appointmentId, reasonCode };
  }
}

/** Writes one saga command to the outbox (published after COMMIT with a publisher confirm). */
export async function enqueueSagaCommand(
  client: DatabaseClient,
  saga: Pick<BookingSaga, 'id' | 'tenantId' | 'actorSubject' | 'actorRole' | 'correlationId'>,
  step: StepName,
  payload: Readonly<Record<string, unknown>>,
  causationId?: string,
): Promise<Envelope> {
  const route = ROUTES[step];
  const envelope = createEnvelope({
    messageId: newId(),
    messageType: route.messageType,
    producer: PRODUCER,
    tenantId: saga.tenantId,
    actor: { subject: saga.actorSubject, roles: [saga.actorRole] },
    correlationId: saga.correlationId,
    ...(causationId === undefined ? {} : { causationId }),
    sagaId: saga.id,
    stepId: step,
    replyTo: PRODUCER,
    payload,
  });
  await enqueueOutbox(client, { exchange: EXCHANGES.commands, routingKey: route.routingKey, envelope });
  return envelope;
}

export async function enqueueBookingFailed(
  client: DatabaseClient,
  saga: Pick<BookingSaga, 'id' | 'tenantId' | 'actorSubject' | 'actorRole' | 'correlationId' | 'appointmentId'>,
  reasonCode: string,
): Promise<void> {
  const envelope = createEnvelope({
    messageType: 'AppointmentBookingFailed',
    producer: PRODUCER,
    tenantId: saga.tenantId,
    actor: { subject: saga.actorSubject, roles: [saga.actorRole] },
    correlationId: saga.correlationId,
    sagaId: saga.id,
    payload: { sagaId: saga.id, appointmentId: saga.appointmentId, reasonCode },
  });
  await enqueueOutbox(client, { exchange: EXCHANGES.events, routingKey: 'booking.appointment.booking-failed', envelope });
}
