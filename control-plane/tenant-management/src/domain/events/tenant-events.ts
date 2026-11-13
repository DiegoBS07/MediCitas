import type { Tenant } from '../entities/tenant.js';

/** Domain events of the tenant aggregate. */
export interface FirstAdmin {
  readonly subject: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
}

export const TENANT_EVENTS = {
  onboarded: { messageType: 'TenantOnboarded', routingKey: 'tenant.tenant.onboarded' },
  onboardingFailed: { messageType: 'TenantOnboardingFailed', routingKey: 'tenant.tenant.onboarding-failed' },
} as const;

export function tenantOnboardedPayload(tenant: Tenant, firstAdmin: FirstAdmin): Readonly<Record<string, unknown>> {
  return {
    tenantId: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    timezone: tenant.timezone,
    status: tenant.status,
    firstAdmin: { ...firstAdmin },
    aggregateVersion: tenant.version,
  };
}

export function tenantOnboardingFailedPayload(tenant: Tenant): Readonly<Record<string, unknown>> {
  return { tenantId: tenant.id, reasonCode: tenant.failureReasonCode, aggregateVersion: tenant.version };
}
