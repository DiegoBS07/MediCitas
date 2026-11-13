import { newId } from '@medicitas/kernel';
import { activate, markOnboardingFailed, type Tenant } from '../../domain/entities/tenant.js';
import { tenantNotFound, tenantSlugTaken } from '../../domain/errors/tenant-errors.js';
import {
  TENANT_EVENTS,
  tenantOnboardedPayload,
  tenantOnboardingFailedPayload,
  type FirstAdmin,
} from '../../domain/events/tenant-events.js';
import { assertSlug, assertTenantName, assertTimezone } from '../../domain/value-objects/tenant-values.js';
import type { TenantRepository } from '../ports/tenant-repository.js';

/** Outbound domain events, written to the outbox in the same transaction. */
export interface EventSink {
  emit(event: {
    readonly messageType: string;
    readonly routingKey: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly tenantId?: string | null;
  }): Promise<unknown>;
}

export interface CreateTenantInput {
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  readonly onboardingSagaId: string;
}

/**
 * CreateTenantCommand (RF1 step 2). Idempotent by the natural key onboarding_saga_id: a re-sent
 * command of the same saga returns the tenant it already created.
 */
export async function createTenant(repository: TenantRepository, input: CreateTenantInput): Promise<Tenant> {
  const slug = assertSlug(input.slug);
  const name = assertTenantName(input.name);
  const timezone = assertTimezone(input.timezone);

  const existing = await repository.findByOnboardingSaga(input.onboardingSagaId);
  if (existing !== null) return existing;

  if ((await repository.findBySlug(slug)) !== null) throw tenantSlugTaken(slug);
  return repository.insert({ id: newId(), slug, name, timezone, onboardingSagaId: input.onboardingSagaId });
}

/** ActivateTenantCommand (RF1 step 5): emits TenantOnboarded exactly once. */
export async function activateTenant(
  repository: TenantRepository,
  events: EventSink,
  input: { readonly tenantId: string; readonly firstAdmin: FirstAdmin },
  now: Date = new Date(),
): Promise<Tenant> {
  const tenant = await repository.findById(input.tenantId, { forUpdate: true });
  if (tenant === null) throw tenantNotFound();
  const transition = activate(tenant, now);
  if (transition.changed) {
    await repository.saveTransition(transition.tenant);
    await events.emit({
      ...TENANT_EVENTS.onboarded,
      payload: tenantOnboardedPayload(transition.tenant, input.firstAdmin),
      tenantId: transition.tenant.id,
    });
  }
  return transition.tenant;
}

/** MarkTenantOnboardingFailedCommand (RF1 compensation): keeps the row, records the reason. */
export async function markTenantOnboardingFailed(
  repository: TenantRepository,
  events: EventSink,
  input: { readonly tenantId: string; readonly reasonCode: string },
  now: Date = new Date(),
): Promise<Tenant> {
  const tenant = await repository.findById(input.tenantId, { forUpdate: true });
  if (tenant === null) throw tenantNotFound();
  const transition = markOnboardingFailed(tenant, input.reasonCode, now);
  if (transition.changed) {
    await repository.saveTransition(transition.tenant);
    await events.emit({
      ...TENANT_EVENTS.onboardingFailed,
      payload: tenantOnboardingFailedPayload(transition.tenant),
      tenantId: transition.tenant.id,
    });
  }
  return transition.tenant;
}
