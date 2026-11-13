import type { Response, Router } from 'express';
import { z } from 'zod';
import { NotFoundError, newId, withTransaction, type DatabasePool } from '@medicitas/kernel';
import { requirePermission, requireTenant, type TenantContext } from '@medicitas/identity';
import {
  attachOperation,
  beginIdempotent,
  contextOf,
  idempotencyKeyOf,
  instantSchema,
  parseInput,
  pathParams,
  problem,
  requestHash,
  sendData,
  tenantTransaction,
  uuidSchema,
} from '@medicitas/runtime';
import { httpStatusOf, type BookingSaga, type PatientRequest } from '../../domain/entities/booking-saga.js';
import { startBooking, type SagaSettings } from '../../application/commands/booking-saga.js';
import { PgSagaRepository } from '../../infrastructure/persistence/pg-saga-repository.js';
import type { SagaWaiter } from '../../infrastructure/workers/saga-waiter.js';

const PREFIX = 'ao';
const ROUTE = '/api/v1/appointments';

const name = z.string().trim().min(1).max(80);
const today = (): string => new Date().toISOString().slice(0, 10);
const newPatient = z
  .object({
    identificationType: z.enum(['national_id', 'passport', 'residence_card', 'other']),
    identificationNumber: z.string().regex(/^[A-Za-z0-9-]{3,30}$/, 'invalid identification number'),
    firstName: name,
    lastName: name,
    birthDate: z.iso.date().refine((value) => value >= '1900-01-01' && value <= today(), 'must be between 1900-01-01 and today'),
    contact: z
      .object({
        email: z.email().max(254).nullable().optional(),
        phone: z.string().regex(/^\+?[0-9 ()-]{7,20}$/, 'invalid phone').nullable().optional(),
        address: z.string().trim().max(300).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
/** endAt / durationMinutes are NOT accepted (I4): the strict schema rejects them with 400. */
const bookingBody = z
  .object({
    patient: z.union([z.object({ id: uuidSchema }).strict(), z.object({ new: newPatient }).strict()]),
    professionalId: uuidSchema,
    serviceId: uuidSchema,
    startAt: instantSchema,
  })
  .strict();

export interface BookingHttpSettings extends SagaSettings {
  /** How long POST /appointments waits for a terminal state before answering 202 (8 s). */
  readonly syncWaitMs: number;
}

function operationView(saga: BookingSaga) {
  const status = saga.status === 'completed' ? 'completed' : saga.status === 'failed' ? 'failed' : 'running';
  return {
    operationId: saga.id,
    type: 'appointment-booking',
    status,
    result: status === 'completed' ? saga.result : null,
    error: status === 'failed' ? { code: saga.errorCode, detail: saga.errorDetail } : null,
    createdAt: saga.createdAt.toISOString(),
    updatedAt: saga.updatedAt.toISOString(),
  };
}

function respond(res: Response, saga: BookingSaga | null, sagaId: string, replayed: boolean, correlationId: string): void {
  if (replayed) res.setHeader('Idempotent-Replayed', 'true');
  if (saga?.status === 'completed' && saga.result !== null) {
    res.setHeader('Location', `/api/v1/appointments/${saga.appointmentId}`);
    sendData(res, 201, saga.result);
    return;
  }
  if (saga?.status === 'failed' && saga.errorCode !== null) {
    const rawDetails = (saga.result?.['details'] ?? {}) as Record<string, unknown>;
    const details = Object.fromEntries(Object.entries(rawDetails).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const body = problem(httpStatusOf(saga.errorCode), saga.errorCode, saga.errorDetail ?? saga.errorCode, correlationId, { details });
    if (body.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(body.retryAfterSeconds));
    res.status(body.status).type('application/problem+json').json(body.body);
    return;
  }
  // Still running: 202 is NOT a failure; the client polls the operation.
  res.setHeader('Location', `/api/v1/appointment-operations/${sagaId}`);
  sendData(res, 202, { operationId: sagaId, status: 'running' });
}

function patientRequest(body: z.infer<typeof bookingBody>): PatientRequest {
  if ('id' in body.patient) return { mode: 'existing', patientId: body.patient.id };
  const { contact, ...rest } = body.patient.new;
  return { mode: 'create', patientId: newId(), patient: { ...rest, contact: contact ?? {} } };
}

/** RF9: POST /appointments starts the booking saga; operations are pollable. */
export function bookingRoutes(pool: DatabasePool, waiter: SagaWaiter, settings: BookingHttpSettings) {
  const readSaga = (context: TenantContext, sagaId: string): Promise<BookingSaga | null> =>
    withTransaction(pool, tenantTransaction(PREFIX, context, { readOnly: true }), (client) => new PgSagaRepository(client).findSaga(sagaId));

  return (router: Router): void => {
    router.post(ROUTE, async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'appointments:book');
      const tenantId = requireTenant(context);
      const key = idempotencyKeyOf(req, true) as string;
      const body = parseInput(bookingBody, req.body, 'body');
      const actorRole = context.role === 'clinic_admin' ? 'clinic_admin' : 'receptionist';

      const started = await withTransaction(pool, tenantTransaction(PREFIX, context), async (client) => {
        const claim = await beginIdempotent(client, { tenantId, method: 'POST', routeTemplate: ROUTE, key, requestHash: requestHash(body) });
        if (claim.kind !== 'new') {
          // Same key and same body: the response is derived from the persisted saga (never re-executed).
          const operationId = claim.kind === 'in_progress' ? claim.operationId : null;
          if (operationId === null) throw new NotFoundError('operation', 'The original operation is no longer available.');
          return { sagaId: operationId, replayed: true };
        }
        const saga = await startBooking(client, settings, {
          patient: patientRequest(body),
          professionalId: body.professionalId,
          serviceId: body.serviceId,
          startAt: body.startAt,
          actorSubject: context.subject,
          actorRole,
          correlationId: context.correlationId,
          tenantId,
        });
        await attachOperation(client, claim.recordId, saga.id);
        return { sagaId: saga.id, replayed: false };
      });

      const finished = await waiter.waitFor(started.sagaId, settings.syncWaitMs, async () => {
        const saga = await readSaga(context, started.sagaId);
        return saga !== null && (saga.status === 'completed' || saga.status === 'failed') ? saga : null;
      });
      respond(res, finished, started.sagaId, started.replayed, context.correlationId);
    });

    router.get('/api/v1/appointment-operations/:operationId', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'appointments:book');
      const { operationId } = parseInput(pathParams({ operationId: uuidSchema }), req.params, 'params');
      const saga = await readSaga(context, operationId);
      if (saga === null) throw new NotFoundError('operation', 'Operation not found.');
      sendData(res, 200, operationView(saga));
    });
  };
}
