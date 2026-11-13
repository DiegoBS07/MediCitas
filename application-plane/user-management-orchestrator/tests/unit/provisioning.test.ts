import { describe, expect, it } from 'vitest';
import type { SagaRecord, SagaStepRecord } from '@medicitas/runtime';
import { httpStatusOf, nextStep } from '../../src/domain/provisioning.js';

const saga = (sagaType: string, status: string, errorCode: string | null = null): SagaRecord => ({
  id: 's',
  tenantId: 't',
  sagaType,
  status,
  request: { userId: 'u', email: 'a@b.test', firstName: 'A', lastName: 'B', role: 'receptionist' },
  result: null,
  errorCode,
  errorDetail: null,
  actorSubject: 'x',
  correlationId: 'c',
  deadlineAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
});
const step = (name: string, status: SagaStepRecord['status'], result: Record<string, unknown> | null = null, errorCode: string | null = null): SagaStepRecord => ({
  name,
  status,
  commandMessageId: null,
  attempts: 1,
  result,
  errorCode,
});

describe('RF2 user creation saga (ADR-0012)', () => {
  it('reserves, creates the identity, then activates with the Keycloak subject', () => {
    expect(nextStep(saga('user-creation', 'started'), [step('reserve_user', 'dispatched')])).toEqual({ kind: 'wait' });
    expect(nextStep(saga('user-creation', 'started'), [step('reserve_user', 'succeeded')])).toMatchObject({ kind: 'local', step: 'keycloak_user' });
    expect(nextStep(saga('user-creation', 'reserved'), [step('keycloak_user', 'succeeded', { keycloakSubject: 'k' })])).toMatchObject({
      kind: 'command',
      step: 'activate_user',
      payload: { userId: 'u', keycloakSubject: 'k' },
    });
    expect(nextStep(saga('user-creation', 'activating'), [step('activate_user', 'succeeded', { userId: 'u' })])).toEqual({ kind: 'complete', result: { userId: 'u' } });
  });

  it('fails without compensation when the reservation is rejected, and compensates after it', () => {
    expect(nextStep(saga('user-creation', 'started'), [step('reserve_user', 'rejected', null, 'EMAIL_TAKEN')])).toEqual({ kind: 'fail', errorCode: 'EMAIL_TAKEN' });
    expect(nextStep(saga('user-creation', 'reserved'), [step('keycloak_user', 'failed', null, 'EMAIL_TAKEN')])).toEqual({ kind: 'compensate', errorCode: 'EMAIL_TAKEN' });
    const compensating = saga('user-creation', 'compensating', 'EMAIL_TAKEN');
    expect(nextStep(compensating, [step('cancel_reservation', 'dispatched'), step('delete_keycloak_user', 'succeeded', { deleted: false })])).toEqual({ kind: 'wait' });
    expect(nextStep(compensating, [step('cancel_reservation', 'succeeded'), step('delete_keycloak_user', 'succeeded', { deleted: true })])).toEqual({
      kind: 'fail',
      errorCode: 'EMAIL_TAKEN',
    });
  });

  it('deletes again an identity created by an in-flight call after the first deletion ran (P5)', () => {
    const compensating = saga('user-creation', 'compensating', 'DEPENDENCY_UNAVAILABLE');
    expect(
      nextStep(compensating, [step('keycloak_user', 'succeeded', { keycloakSubject: 'k' }), step('delete_keycloak_user', 'succeeded', { deleted: false }), step('cancel_reservation', 'succeeded')]),
    ).toMatchObject({ kind: 'local', step: 'delete_keycloak_user' });
  });
});

describe('RF2 role change and deactivation (decision-log S4-4)', () => {
  it('applies the database command first, then makes Keycloak converge', () => {
    expect(nextStep(saga('user-role-change', 'started'), [step('change_role', 'succeeded', { userId: 'u' })])).toMatchObject({ kind: 'local', step: 'keycloak_role' });
    expect(nextStep(saga('user-role-change', 'started'), [step('change_role', 'rejected', null, 'LAST_CLINIC_ADMIN')])).toEqual({ kind: 'fail', errorCode: 'LAST_CLINIC_ADMIN' });
    expect(nextStep(saga('user-deactivation', 'activating'), [step('deactivate_user', 'succeeded', { status: 'inactive' }), step('keycloak_disable', 'succeeded')])).toEqual({
      kind: 'complete',
      result: { status: 'inactive' },
    });
    expect(nextStep(saga('user-deactivation', 'activating'), [step('deactivate_user', 'succeeded', {}), step('keycloak_disable', 'pending')])).toEqual({ kind: 'wait' });
  });

  it('maps failure codes to HTTP statuses', () => {
    expect(httpStatusOf('EMAIL_TAKEN')).toBe(409);
    expect(httpStatusOf('LAST_CLINIC_ADMIN')).toBe(409);
    expect(httpStatusOf('RESOURCE_NOT_FOUND')).toBe(404);
    expect(httpStatusOf('PROVISIONING_INTERRUPTED')).toBe(503);
  });
});
