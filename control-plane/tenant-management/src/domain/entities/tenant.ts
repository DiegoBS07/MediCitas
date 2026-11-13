import { ConflictError } from '@medicitas/kernel';

export const TENANT_STATUSES = ['provisioning', 'active', 'onboarding_failed'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** Tenant aggregate (table tenancy.tenants). */
export interface Tenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly status: TenantStatus;
  readonly failureReasonCode: string | null;
  readonly onboardingSagaId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly activatedAt: Date | null;
}

/** Result of applying a lifecycle transition: `changed` is false for an idempotent repetition. */
export interface Transition {
  readonly tenant: Tenant;
  readonly changed: boolean;
}

function invalidTransition(from: TenantStatus, to: TenantStatus): ConflictError {
  return new ConflictError('INVALID_STATE_TRANSITION', `A tenant cannot go from ${from} to ${to}.`);
}

/** provisioning → active (point of no return of the onboarding saga, ADR-0012). */
export function activate(tenant: Tenant, now: Date): Transition {
  if (tenant.status === 'active') return { tenant, changed: false };
  if (tenant.status !== 'provisioning') throw invalidTransition(tenant.status, 'active');
  return {
    tenant: { ...tenant, status: 'active', version: tenant.version + 1, activatedAt: now, updatedAt: now },
    changed: true,
  };
}

/** provisioning → onboarding_failed (compensation; the row and the slug are kept). */
export function markOnboardingFailed(tenant: Tenant, reasonCode: string, now: Date): Transition {
  if (tenant.status === 'onboarding_failed') return { tenant, changed: false };
  if (tenant.status !== 'provisioning') throw invalidTransition(tenant.status, 'onboarding_failed');
  return {
    tenant: { ...tenant, status: 'onboarding_failed', failureReasonCode: reasonCode, version: tenant.version + 1, updatedAt: now },
    changed: true,
  };
}
