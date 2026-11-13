import { describe, expect, it } from 'vitest';
import type { SagaRecord, SagaStepRecord } from '@medicitas/runtime';
import { httpStatusOf, nextStep } from '../../src/domain/onboarding.js';

const saga = (status: string, tenantId: string | null = null, errorCode: string | null = null): SagaRecord => ({
  id: 's',
  tenantId,
  sagaType: 'tenant-onboarding',
  status,
  request: { name: 'Clinic', slug: 'clinic', timezone: 'America/Panama', firstAdmin: { email: 'a@b.test', firstName: 'A', lastName: 'B' } },
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

describe('RF1 onboarding saga (ADR-0012)', () => {
  it('creates the tenant, then the Keycloak group and admin, then activates', () => {
    expect(nextStep(saga('started'), [step('create_tenant', 'succeeded', { tenantId: 't1' })])).toEqual({
      kind: 'local',
      step: 'keycloak_group',
      status: 'tenant_created',
      tenantId: 't1',
    });
    expect(nextStep(saga('tenant_created', 't1'), [step('keycloak_group', 'succeeded', { groupId: 'g' })])).toMatchObject({ kind: 'local', step: 'keycloak_admin_user' });
    expect(
      nextStep(saga('tenant_created', 't1'), [step('keycloak_group', 'succeeded'), step('keycloak_admin_user', 'succeeded', { keycloakSubject: 'k' })]),
    ).toMatchObject({ kind: 'command', step: 'activate_tenant', payload: { tenantId: 't1', firstAdmin: { subject: 'k', email: 'a@b.test' } } });
    expect(nextStep(saga('activating', 't1'), [step('keycloak_admin_user', 'succeeded', { keycloakSubject: 'k' }), step('activate_tenant', 'succeeded')])).toMatchObject({
      kind: 'complete',
      result: { tenantId: 't1', status: 'active', firstAdmin: { subject: 'k' } },
    });
  });

  it('fails on a rejected tenant and compensates Keycloak failures', () => {
    expect(nextStep(saga('started'), [step('create_tenant', 'rejected', null, 'TENANT_SLUG_TAKEN')])).toEqual({ kind: 'fail', errorCode: 'TENANT_SLUG_TAKEN' });
    expect(nextStep(saga('tenant_created', 't1'), [step('keycloak_group', 'succeeded'), step('keycloak_admin_user', 'failed', null, 'EMAIL_TAKEN')])).toEqual({
      kind: 'compensate',
      errorCode: 'EMAIL_TAKEN',
    });
    const compensating = saga('compensating', 't1', 'EMAIL_TAKEN');
    expect(nextStep(compensating, [step('delete_keycloak_user', 'succeeded'), step('delete_keycloak_group', 'pending'), step('mark_tenant_failed', 'dispatched')])).toEqual({
      kind: 'wait',
    });
    expect(nextStep(compensating, [step('delete_keycloak_user', 'succeeded'), step('delete_keycloak_group', 'succeeded'), step('mark_tenant_failed', 'succeeded')])).toEqual({
      kind: 'fail',
      errorCode: 'EMAIL_TAKEN',
    });
    expect(httpStatusOf('TENANT_SLUG_TAKEN')).toBe(409);
    expect(httpStatusOf('INVALID_TIMEZONE')).toBe(422);
    expect(httpStatusOf('DEPENDENCY_UNAVAILABLE')).toBe(503);
  });
});
