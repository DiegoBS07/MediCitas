import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeycloakAdminClient } from '@medicitas/identity';
import type { RunningService } from '@medicitas/runtime';
import { startOnboarding, type OnboardingConfig } from '../../../control-plane/onboarding-orchestrator/src/service.js';
import { startTenantManagement } from '../../../control-plane/tenant-management/src/service.js';
import { startUserManagement } from '../../../application-plane/user-management/src/service.js';
import { ownerPool } from '../../support/database.js';
import { env } from '../../support/env.js';
import { decodePayload, passwordGrant, provisionerToken, realmUrl } from '../../support/keycloak.js';
import { httpClient, serviceConfig } from '../../support/services.js';
import { tokenOf } from '../../support/tokens.js';

const runId = randomUUID().slice(0, 6);
const tenantOwner = ownerPool('tm', 'medicitas_tenant');
const userOwner = ownerPool('um', 'medicitas_user');
const keycloak = new KeycloakAdminClient({
  baseUrl: env('KEYCLOAK_PUBLIC_URL'),
  realm: 'medicitas',
  clientId: 'medicitas-provisioner',
  clientSecret: env('MEDICITAS_PROVISIONER_CLIENT_SECRET'),
});
const TEMP_PASSWORD = `It-Temp-${randomUUID()}`;
const slugs: string[] = [];
const emails: string[] = [];

let services: RunningService[] = [];
let http: ReturnType<typeof httpClient>;
let tenantsHttp: ReturnType<typeof httpClient>;
let platform: string;

function onboardingConfig(): OnboardingConfig {
  return {
    ...serviceConfig('onb', 'medicitas_onboarding', 'onboarding-orchestrator'),
    keycloakAdmin: {
      baseUrl: env('KEYCLOAK_PUBLIC_URL'),
      realm: 'medicitas',
      clientId: 'medicitas-provisioner',
      clientSecret: env('MEDICITAS_PROVISIONER_CLIENT_SECRET'),
      timeoutMs: 3_000,
      retryDelaysMs: [100, 300],
    },
    saga: { deadlineMs: 60_000, syncWaitMs: 12_000, resendMs: 5_000, convergeWindowMs: 60_000, compensationWindowMs: 30_000, sweepIntervalMs: 250, localRetryMs: 500 },
  };
}

function request(label: string, overrides: { readonly slug?: string; readonly email?: string; readonly timezone?: string } = {}) {
  const slug = overrides.slug ?? `it-${runId}-${label}`;
  const email = overrides.email ?? `admin.${label}.${runId}@it.medicitas.test`;
  slugs.push(slug);
  emails.push(email);
  return {
    name: `Integration ${label}`,
    slug,
    timezone: overrides.timezone ?? 'America/Costa_Rica',
    firstAdmin: { email, firstName: 'Ada', lastName: 'Admin', temporaryPassword: TEMP_PASSWORD },
  };
}

const onboard = (body: Record<string, unknown>, key = `it-onb-${randomUUID()}`, token = platform) =>
  http<{ data: { tenantId: string; status: string; operationId: string; firstAdmin: { subject: string; email: string } }; code?: string }>(
    'POST',
    '/api/v1/tenants',
    { token, body, headers: { 'Idempotency-Key': key } },
  );

beforeAll(async () => {
  services = await Promise.all([
    startTenantManagement(serviceConfig('tm', 'medicitas_tenant', 'tenant-management')),
    startUserManagement(serviceConfig('um', 'medicitas_user', 'user-management')),
    startOnboarding(onboardingConfig()),
  ]);
  tenantsHttp = httpClient((services[0] as RunningService).port);
  http = httpClient((services[2] as RunningService).port);
  platform = await tokenOf('platformAdmin');
});

afterAll(async () => {
  for (const service of [...services].reverse()) await service.stop();
  for (const email of emails) {
    const user = await keycloak.findUserByUsername(email);
    if (user !== null) await keycloak.deleteUser(user.id);
  }
  for (const slug of slugs) {
    const group = await keycloak.groupByPath(`/tenants/${slug}`);
    if (group !== null) await keycloak.deleteGroup(group.id);
  }
  await userOwner.query(`DELETE FROM identity.users WHERE tenant_id IN (SELECT id FROM identity.tenants WHERE slug LIKE 'it-%')`);
  await userOwner.query(`DELETE FROM identity.tenants WHERE slug LIKE 'it-%'`);
  await tenantOwner.query(`DELETE FROM tenancy.tenants WHERE slug LIKE 'it-%'`);
  await Promise.all([tenantOwner.end(), userOwner.end()]);
});

describe('RF1 onboarding saga (tenant-management + Keycloak)', () => {
  it('onboards a clinic end to end: tenant active, Keycloak group and first admin, TenantOnboarded consumed', async () => {
    const body = request('ok');
    const key = `it-onb-${runId}-ok`;
    const created = await onboard(body, key);
    expect(created.status).toBe(201);
    const tenantId = created.body.data.tenantId;
    expect(created.body.data).toMatchObject({ status: 'active', firstAdmin: { email: body.firstAdmin.email } });
    expect(created.headers.get('location')).toBe(`/api/v1/tenants/${tenantId}`);

    const tenant = await tenantsHttp('GET', `/api/v1/tenants/${tenantId}`, { token: platform });
    expect(tenant.body).toMatchObject({ data: { slug: body.slug, status: 'active' } });
    const group = await keycloak.groupByPath(`/tenants/${body.slug}`);
    expect(group?.attributes['tenant_id']).toEqual([tenantId]);
    const admin = await keycloak.findUserByUsername(body.firstAdmin.email);
    expect(admin?.attributes['tenant_id']).toEqual([tenantId]);
    expect(await keycloak.realmRolesOf(admin?.id ?? '')).toContain('clinic_admin');

    // TenantOnboarded → user-management registers the first admin with the Keycloak subject.
    await expect
      .poll(async () => (await userOwner.query('SELECT role, status FROM identity.users WHERE keycloak_subject = $1', [admin?.id])).rows[0], { timeout: 15_000 })
      .toEqual({ role: 'clinic_admin', status: 'active' });

    // Once the temporary password is replaced, the admin logs in and the token carries tenant_id.
    const reset = await fetch(`${realmUrl().replace('/realms/', '/admin/realms/')}/users/${admin?.id}/reset-password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${await provisionerToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'password', value: `${TEMP_PASSWORD}-final`, temporary: false }),
    });
    expect(reset.status).toBe(204);
    const token = await passwordGrant(body.firstAdmin.email, `${TEMP_PASSWORD}-final`);
    expect(decodePayload(token)).toMatchObject({ tenant_id: tenantId });

    const replay = await onboard(body, key);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body.data.tenantId).toBe(tenantId);
    const operation = await http<{ data: { status: string } }>('GET', `/api/v1/tenant-onboardings/${created.body.data.operationId}`, { token: platform });
    expect(operation.body.data.status).toBe('completed');
  });

  it('rejects a taken slug and an invalid timezone without touching Keycloak', async () => {
    const taken = await onboard(request('dup', { slug: 'clinica-san-jose' }));
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'TENANT_SLUG_TAKEN' });
    const badZone = await onboard(request('tz', { timezone: 'Mars/Olympus_Mons' }));
    expect(badZone.status).toBe(422);
    expect(badZone.body).toMatchObject({ code: 'INVALID_TIMEZONE' });
    expect(await keycloak.groupByPath(`/tenants/it-${runId}-tz`)).toBeNull();
  });

  it('compensates when the admin e-mail already has a foreign identity: group deleted, tenant marked failed', async () => {
    const body = request('clash', { email: 'ana.mora@sanjose.medicitas.test' });
    emails.pop(); // never delete the seeded identity
    const response = await onboard(body);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'EMAIL_TAKEN' });
    expect(await keycloak.groupByPath(`/tenants/${body.slug}`)).toBeNull();
    expect((await keycloak.findUserByUsername('ana.mora@sanjose.medicitas.test'))?.enabled).toBe(true);
    await expect
      .poll(async () => (await tenantOwner.query('SELECT status, failure_reason_code FROM tenancy.tenants WHERE slug = $1', [body.slug])).rows[0], { timeout: 15_000 })
      .toEqual({ status: 'onboarding_failed', failure_reason_code: 'EMAIL_TAKEN' });
  });

  it('is reserved to the platform administrator and validates the request', async () => {
    expect((await onboard(request('forbidden'), undefined, await tokenOf('clinic1Admin'))).status).toBe(403);
    const missingKey = await http('POST', '/api/v1/tenants', { token: platform, body: request('nokey') });
    expect(missingKey.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect((await onboard({ ...request('extra'), tenantId: randomUUID() })).status).toBe(400);
    expect((await onboard(request('BAD_SLUG', { slug: 'Bad Slug' }))).status).toBe(400);
  });
});
