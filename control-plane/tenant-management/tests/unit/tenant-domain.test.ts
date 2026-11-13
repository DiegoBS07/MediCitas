import { describe, expect, it } from 'vitest';
import { activate, markOnboardingFailed, type Tenant } from '../../src/domain/entities/tenant.js';
import { assertSlug, assertTimezone } from '../../src/domain/value-objects/tenant-values.js';
import { activateTenant, createTenant } from '../../src/application/commands/tenant-commands.js';
import type { NewTenant, TenantRepository } from '../../src/application/ports/tenant-repository.js';

const base: Tenant = {
  id: '10000000-0000-4000-8000-0000000000aa',
  slug: 'clinica-prueba',
  name: 'Clínica Prueba',
  timezone: 'America/Costa_Rica',
  status: 'provisioning',
  failureReasonCode: null,
  onboardingSagaId: '60000000-0000-4000-8000-0000000000aa',
  version: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  activatedAt: null,
};

class MemoryRepository implements TenantRepository {
  readonly tenants = new Map<string, Tenant>();
  async findById(id: string) {
    return this.tenants.get(id) ?? null;
  }
  async findBySlug(slug: string) {
    return [...this.tenants.values()].find((tenant) => tenant.slug === slug) ?? null;
  }
  async findByOnboardingSaga(sagaId: string) {
    return [...this.tenants.values()].find((tenant) => tenant.onboardingSagaId === sagaId) ?? null;
  }
  async insert(tenant: NewTenant) {
    const created: Tenant = { ...base, ...tenant };
    this.tenants.set(created.id, created);
    return created;
  }
  async saveTransition(tenant: Tenant) {
    this.tenants.set(tenant.id, tenant);
  }
  async list() {
    return [];
  }
}

describe('tenant lifecycle (RF1)', () => {
  it('activates a provisioning tenant once and treats a repetition as idempotent', () => {
    const now = new Date('2026-02-01T00:00:00Z');
    const first = activate(base, now);
    expect(first.changed).toBe(true);
    expect(first.tenant).toMatchObject({ status: 'active', version: 2, activatedAt: now });
    const again = activate(first.tenant, now);
    expect(again.changed).toBe(false);
    expect(again.tenant.version).toBe(2);
  });

  it('never activates a failed onboarding and never fails an active tenant', () => {
    const failed = markOnboardingFailed(base, 'IDENTITY_PROVIDER_UNAVAILABLE', new Date()).tenant;
    expect(failed).toMatchObject({ status: 'onboarding_failed', failureReasonCode: 'IDENTITY_PROVIDER_UNAVAILABLE' });
    expect(() => activate(failed, new Date())).toThrowError(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
    const active = activate(base, new Date()).tenant;
    expect(() => markOnboardingFailed(active, 'X_Y', new Date())).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
  });

  it('validates slugs and IANA timezones', () => {
    expect(assertSlug('clinica-san-jose')).toBe('clinica-san-jose');
    for (const slug of ['A-clinic', '-clinic', 'clinic-', 'c', 'clínica']) {
      expect(() => assertSlug(slug)).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
    expect(assertTimezone('America/Costa_Rica')).toBe('America/Costa_Rica');
    for (const zone of ['Mars/Olympus', 'Local', '../etc/passwd', '']) {
      expect(() => assertTimezone(zone)).toThrowError(expect.objectContaining({ code: 'INVALID_TIMEZONE' }));
    }
  });
});

describe('tenant commands', () => {
  it('is idempotent per onboarding saga and rejects a slug used by another saga', async () => {
    const repository = new MemoryRepository();
    const input = { name: 'Clínica Prueba', slug: 'clinica-prueba', timezone: 'America/Panama', onboardingSagaId: base.onboardingSagaId };
    const first = await createTenant(repository, input);
    const second = await createTenant(repository, input);
    expect(second.id).toBe(first.id);
    await expect(
      createTenant(repository, { ...input, onboardingSagaId: '60000000-0000-4000-8000-0000000000bb' }),
    ).rejects.toMatchObject({ code: 'TENANT_SLUG_TAKEN' });
  });

  it('emits TenantOnboarded only on the first activation', async () => {
    const repository = new MemoryRepository();
    repository.tenants.set(base.id, base);
    const emitted: string[] = [];
    const sink = { emit: async (event: { readonly messageType: string }) => void emitted.push(event.messageType) };
    const firstAdmin = { subject: '30000000-0000-4000-8000-0000000000aa', email: 'a@b.test', firstName: 'A', lastName: 'B' };
    await activateTenant(repository, sink, { tenantId: base.id, firstAdmin });
    await activateTenant(repository, sink, { tenantId: base.id, firstAdmin });
    expect(emitted).toEqual(['TenantOnboarded']);
    await expect(
      activateTenant(repository, sink, { tenantId: '10000000-0000-4000-8000-0000000000ff', firstAdmin }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});
