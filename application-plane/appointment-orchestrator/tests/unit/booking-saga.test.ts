import { describe, expect, it } from 'vitest';
import { decide, failureReason, httpStatusOf, type BookingSaga, type SagaStep, type StepName, type StepReply } from '../../src/domain/entities/booking-saga.js';

const saga: BookingSaga = {
  id: 's',
  tenantId: 't',
  appointmentId: 'a',
  patientId: 'p',
  professionalId: 'pr',
  serviceId: 'sv',
  startAt: new Date(),
  patientMode: 'existing',
  status: 'awaiting_participants',
  result: null,
  errorCode: null,
  errorDetail: null,
  actorSubject: 'u',
  actorRole: 'receptionist',
  correlationId: 'c',
  deadlineAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const ok = (result: Record<string, unknown> = {}): StepReply => ({ outcome: 'succeeded', result, error: null });
const rejected = (code: string, result: Record<string, unknown> | null = null): StepReply => ({
  outcome: 'rejected',
  result,
  error: { code, message: code, retryable: false },
});
const step = (name: StepName, reply: StepReply | null): SagaStep => ({
  name,
  status: reply === null ? 'dispatched' : reply.outcome,
  commandMessageId: name,
  reply,
});

describe('booking saga aggregation', () => {
  it('waits for every participant, then confirms when Catalog and the scheduler replica agree', () => {
    const catalog = ok({ durationMinutes: 30, serviceVersion: 3 });
    expect(decide(saga, [step('patient', ok()), step('catalog', catalog), step('slot', null)])).toEqual({ kind: 'wait' });
    expect(decide(saga, [step('patient', ok()), step('catalog', catalog), step('slot', ok({ durationMinutes: 30, serviceVersion: 3 }))])).toEqual({
      kind: 'confirm',
    });
  });

  it('compensates a stale replica (duration or version mismatch)', () => {
    const steps = [step('patient', ok()), step('catalog', ok({ durationMinutes: 45, serviceVersion: 4 })), step('slot', ok({ durationMinutes: 30, serviceVersion: 3 }))];
    expect(decide(saga, steps)).toEqual({ kind: 'compensate', errorCode: 'CATALOG_REPLICA_STALE' });
  });

  it('releases the slot only if it was held or its outcome is unknown', () => {
    expect(decide(saga, [step('patient', rejected('PATIENT_INACTIVE')), step('catalog', null), step('slot', null)]).kind).toBe('compensate');
    expect(decide(saga, [step('patient', null), step('catalog', null), step('slot', rejected('SLOT_TAKEN'))]).kind).toBe('fail');
  });

  it('completes on confirmation and treats an expired hold as an interrupted booking', () => {
    const confirming = { ...saga, status: 'confirming' as const };
    expect(decide(confirming, [step('confirm', ok({ appointmentId: 'a' }))])).toEqual({ kind: 'complete', appointment: { appointmentId: 'a' } });
    expect(decide(confirming, [step('confirm', rejected('HOLD_EXPIRED'))])).toEqual({ kind: 'compensate', errorCode: 'BOOKING_INTERRUPTED' });
    expect(decide({ ...saga, status: 'compensating' }, [step('release', ok({ released: true }))])).toEqual({ kind: 'fail', errorCode: null });
  });

  it('reports the most specific failure and maps it to HTTP', () => {
    const reason = failureReason([step('catalog', rejected('PROFESSIONAL_NOT_QUALIFIED')), step('slot', rejected('SLOT_TAKEN'))], 'DEPENDENCY_UNAVAILABLE');
    expect(reason.code).toBe('SLOT_TAKEN');
    const duplicate = failureReason([step('patient', rejected('PATIENT_IDENTIFICATION_TAKEN', { existingPatientId: 'p1' }))], null);
    expect(duplicate).toMatchObject({ code: 'PATIENT_IDENTIFICATION_TAKEN', details: { patientId: 'p1' } });
    expect(httpStatusOf('SLOT_TAKEN')).toBe(409);
    expect(httpStatusOf('OUTSIDE_WORKING_HOURS')).toBe(422);
    expect(httpStatusOf('RESOURCE_NOT_FOUND')).toBe(404);
    expect(httpStatusOf('CATALOG_REPLICA_STALE')).toBe(503);
  });
});
