import type { SagaRecord, SagaStepRecord } from '@medicitas/runtime';

/** RF1 saga: STARTED → TENANT_CREATED → IDENTITY_PROVISIONED → ACTIVATING → COMPLETED, or → COMPENSATING → FAILED. */
export const COMMANDS = {
  create_tenant: { messageType: 'CreateTenantCommand', routingKey: 'tenant-management.tenant.create' },
  activate_tenant: { messageType: 'ActivateTenantCommand', routingKey: 'tenant-management.tenant.activate' },
  mark_tenant_failed: { messageType: 'MarkTenantOnboardingFailedCommand', routingKey: 'tenant-management.tenant.mark-failed' },
} as const;
export type CommandStep = keyof typeof COMMANDS;
export type LocalStep = 'keycloak_group' | 'keycloak_admin_user' | 'delete_keycloak_user' | 'delete_keycloak_group';

export interface OnboardingRequest {
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  readonly firstAdmin: { readonly email: string; readonly firstName: string; readonly lastName: string };
}

export type Next =
  | { readonly kind: 'wait' }
  | { readonly kind: 'local'; readonly step: LocalStep; readonly status: string; readonly tenantId?: string }
  | { readonly kind: 'command'; readonly step: CommandStep; readonly status: string; readonly payload: Readonly<Record<string, unknown>> }
  | { readonly kind: 'compensate'; readonly errorCode: string }
  | { readonly kind: 'complete'; readonly result: Readonly<Record<string, unknown>> }
  | { readonly kind: 'fail'; readonly errorCode: string };

const finished = (step: SagaStepRecord | undefined): boolean =>
  step === undefined || step.status === 'succeeded' || step.status === 'rejected' || step.status === 'failed' || step.status === 'skipped';
const bad = (step: SagaStepRecord | undefined): boolean => step?.status === 'rejected' || step?.status === 'failed';

export function nextStep(saga: SagaRecord, steps: readonly SagaStepRecord[]): Next {
  const step = (name: string): SagaStepRecord | undefined => steps.find((candidate) => candidate.name === name);
  const request = saga.request as unknown as OnboardingRequest;
  switch (saga.status) {
    case 'started': {
      const create = step('create_tenant');
      if (bad(create)) return { kind: 'fail', errorCode: create?.errorCode ?? 'DEPENDENCY_UNAVAILABLE' };
      const tenantId = create?.result?.['tenantId'];
      return create?.status === 'succeeded' && typeof tenantId === 'string'
        ? { kind: 'local', step: 'keycloak_group', status: 'tenant_created', tenantId }
        : { kind: 'wait' };
    }
    case 'tenant_created': {
      const group = step('keycloak_group');
      const admin = step('keycloak_admin_user');
      if (bad(group)) return { kind: 'compensate', errorCode: group?.errorCode ?? 'DEPENDENCY_UNAVAILABLE' };
      if (group?.status === 'succeeded' && admin === undefined) return { kind: 'local', step: 'keycloak_admin_user', status: 'tenant_created' };
      if (bad(admin)) return { kind: 'compensate', errorCode: admin?.errorCode ?? 'DEPENDENCY_UNAVAILABLE' };
      if (admin?.status !== 'succeeded') return { kind: 'wait' };
      return {
        kind: 'command',
        step: 'activate_tenant',
        status: 'activating',
        payload: {
          tenantId: saga.tenantId,
          firstAdmin: { subject: admin.result?.['keycloakSubject'], ...request.firstAdmin },
        },
      };
    }
    case 'activating': {
      const activation = step('activate_tenant');
      if (bad(activation)) return { kind: 'fail', errorCode: activation?.errorCode ?? 'DEPENDENCY_UNAVAILABLE' };
      if (activation?.status !== 'succeeded') return { kind: 'wait' };
      return {
        kind: 'complete',
        result: {
          tenantId: saga.tenantId,
          slug: request.slug,
          name: request.name,
          timezone: request.timezone,
          status: 'active',
          operationId: saga.id,
          firstAdmin: { subject: step('keycloak_admin_user')?.result?.['keycloakSubject'], email: request.firstAdmin.email },
        },
      };
    }
    case 'compensating':
      return finished(step('delete_keycloak_user')) && finished(step('delete_keycloak_group')) && finished(step('mark_tenant_failed'))
        ? { kind: 'fail', errorCode: saga.errorCode ?? 'DEPENDENCY_UNAVAILABLE' }
        : { kind: 'wait' };
    default:
      return { kind: 'wait' };
  }
}

/** HTTP status of a terminal failure. */
export function httpStatusOf(code: string): number {
  switch (code) {
    case 'TENANT_SLUG_TAKEN':
    case 'EMAIL_TAKEN':
      return 409;
    case 'INVALID_TIMEZONE':
      return 422;
    default:
      return 503;
  }
}
