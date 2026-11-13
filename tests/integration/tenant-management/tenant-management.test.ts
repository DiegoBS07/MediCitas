import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXCHANGES, type Envelope } from '@medicitas/messaging';
import type { RunningService } from '@medicitas/runtime';
import { startTenantManagement } from '../../../control-plane/tenant-management/src/service.js';
import { ownerPool } from '../../support/database.js';
import { MessageTap, ServiceProbe, httpClient, managementApi, serviceConfig } from '../../support/services.js';
import { tokenOf } from '../../support/tokens.js';
import { waitFor } from '../../support/env.js';

const PLATFORM_ACTOR = { subject: '30000000-0000-4000-8000-000000000000', roles: ['platform_admin' as const] };
const owner = ownerPool('tm', 'medicitas_tenant');
let service: RunningService;
let http: ReturnType<typeof httpClient>;
let onboarding: ServiceProbe;
let intruder: ServiceProbe;
let replies: MessageTap;
let events: MessageTap;

beforeAll(async () => {
  service = await startTenantManagement(serviceConfig('tm', 'medicitas_tenant', 'tenant-management'));
  http = httpClient(service.port);
  onboarding = new ServiceProbe('onboarding-orchestrator');
  intruder = new ServiceProbe('appointment-orchestrator');
  await Promise.all([onboarding.ready(), intruder.ready()]);
  replies = await MessageTap.open([{ exchange: EXCHANGES.replies, routingKey: 'onboarding-orchestrator' }]);
  events = await MessageTap.open([{ exchange: EXCHANGES.events, routingKey: 'tenant.tenant.*' }]);
});

afterAll(async () => {
  await owner.query("DELETE FROM tenancy.tenants WHERE slug LIKE 'it-%'");
  await owner.end();
  await replies.close();
  await events.close();
  await onboarding.close();
  await intruder.close();
  await service.stop();
});

function createCommand(slug: string, overrides: { readonly sagaId?: string; readonly timezone?: string } = {}): Envelope {
  return onboarding.envelope({
    messageType: 'CreateTenantCommand',
    tenantId: null,
    actor: PLATFORM_ACTOR,
    sagaId: overrides.sagaId ?? randomUUID(),
    stepId: 'tenant',
    replyTo: 'onboarding-orchestrator',
    payload: { name: 'Integration Clinic', slug, timezone: overrides.timezone ?? 'America/Costa_Rica' },
  });
}

async function replyTo(command: Envelope): Promise<Envelope> {
  return replies.waitFor((message) => message.commandId === command.messageId);
}

describe('tenant-management HTTP (RF1 reads, RF17)', () => {
  it('serves health endpoints without authentication', async () => {
    expect((await http('GET', '/health/live')).status).toBe(200);
    const ready = await http('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok' });
  });

  it('returns 401 without a token and 403 for a clinical role', async () => {
    const anonymous = await http('GET', '/api/v1/tenants');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(anonymous.headers.get('www-authenticate')).toContain('Bearer');
    const forged = await http('GET', '/api/v1/tenants', { token: 'aaa.bbb.ccc' });
    expect(forged.body).toMatchObject({ code: 'TOKEN_INVALID' });
    const receptionist = await http('GET', '/api/v1/tenants', { token: await tokenOf('clinic1Receptionist') });
    expect(receptionist.status).toBe(403);
    expect(receptionist.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lists tenants with keyset pagination for the platform administrator', async () => {
    const token = await tokenOf('platformAdmin');
    const first = await http<{ data: { slug: string }[]; page: { nextCursor: string | null } }>('GET', '/api/v1/tenants?limit=2', { token });
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.page.nextCursor).not.toBeNull();
    const second = await http<{ data: { slug: string }[] }>(
      'GET',
      `/api/v1/tenants?limit=2&cursor=${first.body.page.nextCursor ?? ''}`,
      { token },
    );
    const slugs = [...first.body.data, ...second.body.data].map((tenant) => tenant.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toEqual(expect.arrayContaining(['clinica-san-jose', 'centro-medico-heredia']));
    expect((await http('GET', '/api/v1/tenants?cursor=%%%', { token })).status).toBe(400);
    expect((await http('GET', '/api/v1/tenants?unknown=1', { token })).status).toBe(400);
  });

  it('returns a tenant by id, 404 for an unknown id and 400 for a malformed id', async () => {
    const token = await tokenOf('platformAdmin');
    const found = await http('GET', '/api/v1/tenants/10000000-0000-4000-8000-000000000001', { token });
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ data: { slug: 'clinica-san-jose', timezone: 'America/Costa_Rica', status: 'active' } });
    const missing = await http('GET', `/api/v1/tenants/${randomUUID()}`, { token });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'RESOURCE_NOT_FOUND', correlationId: missing.headers.get('x-correlation-id') });
    expect((await http('GET', '/api/v1/tenants/not-a-uuid', { token })).status).toBe(400);
  });

  it('echoes a valid client correlation id', async () => {
    const correlationId = randomUUID();
    const response = await http('GET', '/api/v1/tenants/not-a-uuid', {
      token: await tokenOf('platformAdmin'),
      headers: { 'X-Correlation-Id': correlationId },
    });
    expect(response.headers.get('x-correlation-id')).toBe(correlationId);
    expect(response.body).toMatchObject({ correlationId });
  });
});

describe('tenant-management commands (RF1 saga participant)', () => {
  it('creates, activates and announces a tenant exactly once', async () => {
    const slug = `it-${randomUUID().slice(0, 8)}`;
    const create = createCommand(slug);
    await onboarding.command('tenant-management.tenant.create', create);
    const created = await replyTo(create);
    expect(created).toMatchObject({ messageType: 'TenantCreatedReply', producer: 'tenant-management', sagaId: create.sagaId });
    expect(created.payload).toMatchObject({ outcome: 'succeeded', result: { status: 'provisioning' } });
    const tenantId = String((created.payload['result'] as { tenantId: string }).tenantId);

    // Duplicate delivery (same messageId): the stored reply is re-published, nothing is re-applied.
    await onboarding.command('tenant-management.tenant.create', create);
    await waitFor(() => replies.messages.filter((message) => message.commandId === create.messageId).length === 2, 10_000);
    const replayed = replies.messages.filter((message) => message.commandId === create.messageId);
    expect(replayed[1]?.messageId).toBe(replayed[0]?.messageId);

    // A re-created command of the same saga (new messageId) is idempotent by the natural key.
    const recreated = createCommand(slug, { sagaId: create.sagaId ?? undefined });
    await onboarding.command('tenant-management.tenant.create', recreated);
    expect((await replyTo(recreated)).payload).toMatchObject({ outcome: 'succeeded', result: { tenantId } });

    const activate = onboarding.envelope({
      messageType: 'ActivateTenantCommand',
      tenantId,
      actor: PLATFORM_ACTOR,
      sagaId: create.sagaId,
      stepId: 'activate',
      replyTo: 'onboarding-orchestrator',
      payload: {
        tenantId,
        firstAdmin: { subject: randomUUID(), email: `admin@${slug}.test`, firstName: 'Ada', lastName: 'Admin' },
      },
    });
    await onboarding.command('tenant-management.tenant.activate', activate);
    expect((await replyTo(activate)).payload).toMatchObject({ outcome: 'succeeded', result: { tenantId, status: 'active' } });

    const onboarded = await events.waitFor((message) => message.messageType === 'TenantOnboarded' && message.tenantId === tenantId);
    expect(onboarded.payload).toMatchObject({ tenantId, slug, timezone: 'America/Costa_Rica', status: 'active', aggregateVersion: 2 });
    expect(onboarded.correlationId).toBe(activate.correlationId);

    const detail = await http('GET', `/api/v1/tenants/${tenantId}`, { token: await tokenOf('platformAdmin') });
    expect(detail.body).toMatchObject({ data: { status: 'active' } });
  });

  it('rejects a taken slug and an invalid timezone as business outcomes', async () => {
    const taken = createCommand('clinica-san-jose');
    await onboarding.command('tenant-management.tenant.create', taken);
    expect((await replyTo(taken)).payload).toMatchObject({ outcome: 'rejected', error: { code: 'TENANT_SLUG_TAKEN' } });

    const badZone = createCommand(`it-${randomUUID().slice(0, 8)}`, { timezone: 'Mars/Olympus_Mons' });
    await onboarding.command('tenant-management.tenant.create', badZone);
    expect((await replyTo(badZone)).payload).toMatchObject({ outcome: 'rejected', error: { code: 'INVALID_TIMEZONE' } });
  });

  it('marks a provisioning tenant as failed (compensation) and never reactivates it', async () => {
    const slug = `it-${randomUUID().slice(0, 8)}`;
    const create = createCommand(slug);
    await onboarding.command('tenant-management.tenant.create', create);
    const tenantId = String(((await replyTo(create)).payload['result'] as { tenantId: string }).tenantId);

    const markFailed = onboarding.envelope({
      messageType: 'MarkTenantOnboardingFailedCommand',
      tenantId,
      actor: PLATFORM_ACTOR,
      sagaId: create.sagaId,
      replyTo: 'onboarding-orchestrator',
      payload: { tenantId, reasonCode: 'IDENTITY_PROVIDER_UNAVAILABLE' },
    });
    await onboarding.command('tenant-management.tenant.mark-failed', markFailed);
    expect((await replyTo(markFailed)).payload).toMatchObject({ outcome: 'succeeded', result: { status: 'onboarding_failed' } });
    await events.waitFor((message) => message.messageType === 'TenantOnboardingFailed' && message.tenantId === tenantId);

    const activate = onboarding.envelope({
      messageType: 'ActivateTenantCommand',
      tenantId,
      actor: PLATFORM_ACTOR,
      sagaId: create.sagaId,
      replyTo: 'onboarding-orchestrator',
      payload: { tenantId, firstAdmin: { subject: randomUUID(), email: 'x@y.test', firstName: 'X', lastName: 'Y' } },
    });
    await onboarding.command('tenant-management.tenant.activate', activate);
    expect((await replyTo(activate)).payload).toMatchObject({ outcome: 'rejected', error: { code: 'INVALID_STATE_TRANSITION' } });
  });

  it('dead-letters commands from a producer that is not allowed, without applying them', async () => {
    const slug = `it-${randomUUID().slice(0, 8)}`;
    const forged = intruder.envelope({
      messageType: 'CreateTenantCommand',
      tenantId: null,
      actor: PLATFORM_ACTOR,
      sagaId: randomUUID(),
      replyTo: 'appointment-orchestrator',
      payload: { name: 'Forged', slug, timezone: 'America/Costa_Rica' },
    });
    await intruder.command('tenant-management.tenant.create', forged);
    const api = managementApi();
    let reason: unknown;
    for (let attempt = 0; attempt < 25 && reason === undefined; attempt += 1) {
      const messages = await api.takeMessages('tenant-management.commands.dlq', 10);
      const match = messages.find((message) => message.payload.includes(forged.messageId));
      if (match !== undefined) {
        reason = (match.properties['headers'] as Record<string, unknown> | undefined)?.['x-dead-letter-reason'];
      } else {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    expect(reason).toBe('PRODUCER_NOT_ALLOWED');
    const { rowCount } = await owner.query('SELECT 1 FROM tenancy.tenants WHERE slug = $1', [slug]);
    expect(rowCount).toBe(0);
  });
});
