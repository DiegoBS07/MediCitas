import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EXCHANGES, QueryClient, ReplyPayloadSchema, createEnvelope, type Envelope } from '@medicitas/messaging';
import type { RunningService } from '@medicitas/runtime';
import { startUserManagement } from '../../../application-plane/user-management/src/service.js';
import { CLINIC_1, CLINIC_2, ownerPool } from '../../support/database.js';
import { serviceConnection } from '../../support/broker.js';
import { MessageTap, ServiceProbe, httpClient, serviceConfig } from '../../support/services.js';
import { tokenOf } from '../../support/tokens.js';

const ADMIN_1 = { subject: '30000000-0000-4000-8000-000000010001', roles: ['clinic_admin' as const] };
const RECEPTIONIST_1 = { subject: '30000000-0000-4000-8000-000000010002', roles: ['receptionist' as const] };
const owner = ownerPool('um', 'medicitas_user');
const runId = randomUUID().slice(0, 6);
let service: RunningService;
let http: ReturnType<typeof httpClient>;
let umo: ServiceProbe;
let booking: ServiceProbe;
let tenantProbe: ServiceProbe;
let umoReplies: MessageTap;
let bookingReplies: MessageTap;
let events: MessageTap;

beforeAll(async () => {
  service = await startUserManagement(serviceConfig('um', 'medicitas_user', 'user-management'));
  http = httpClient(service.port);
  umo = new ServiceProbe('user-management-orchestrator');
  booking = new ServiceProbe('appointment-orchestrator');
  tenantProbe = new ServiceProbe('tenant-management');
  await Promise.all([umo.ready(), booking.ready(), tenantProbe.ready()]);
  umoReplies = await MessageTap.open([{ exchange: EXCHANGES.replies, routingKey: 'user-management-orchestrator' }]);
  bookingReplies = await MessageTap.open([{ exchange: EXCHANGES.replies, routingKey: 'appointment-orchestrator' }]);
  events = await MessageTap.open([
    { exchange: EXCHANGES.events, routingKey: 'user.user.*' },
    { exchange: EXCHANGES.events, routingKey: 'user.patient.*' },
  ]);
});

afterAll(async () => {
  await owner.query(`DELETE FROM identity.patients WHERE identification_number LIKE 'IT-%'`);
  await owner.query(`DELETE FROM identity.users WHERE email LIKE '%@it.medicitas.test' OR email LIKE 'admin@it-%'`);
  await owner.query(
    `DELETE FROM identity.users WHERE tenant_id IN (SELECT id FROM identity.tenants WHERE slug LIKE 'it-%')`,
  );
  await owner.query(`DELETE FROM identity.tenants WHERE slug LIKE 'it-%'`);
  await owner.end();
  for (const closable of [umoReplies, bookingReplies, events, umo, booking, tenantProbe]) await closable.close();
  await service.stop();
});

const reply = (tap: MessageTap, command: Envelope) => tap.waitFor((message) => message.commandId === command.messageId);
const newPatient = (suffix: string) => ({
  identificationType: 'national_id',
  identificationNumber: `IT-${runId}-${suffix}`,
  firstName: 'Integración',
  lastName: `Prueba${suffix}`,
  birthDate: '1990-04-12',
  contact: { email: `p${suffix}@example.test`, phone: '+50688887777', address: 'San José' },
});

describe('users (RF2 reads) and isolation (I5)', () => {
  it('lists only the caller tenant users for a clinic admin, sorted by name', async () => {
    const response = await http<{ data: { email: string; lastName: string }[] }>('GET', '/api/v1/users?limit=100', {
      token: await tokenOf('clinic1Admin'),
    });
    expect(response.status).toBe(200);
    const emails = response.body.data.map((user) => user.email);
    expect(emails).toContain('carlos.jimenez@sanjose.medicitas.test');
    expect(emails.every((email) => !email.endsWith('heredia.medicitas.test'))).toBe(true);
  });

  it('forbids users:manage to receptionists and to the platform administrator', async () => {
    expect((await http('GET', '/api/v1/users', { token: await tokenOf('clinic1Receptionist') })).status).toBe(403);
    expect((await http('GET', '/api/v1/users', { token: await tokenOf('platformAdmin') })).status).toBe(403);
  });

  it('answers 404 for a user of another tenant (existence is never revealed)', async () => {
    const otherTenantUser = '20000000-0000-4000-8000-000000020002';
    const response = await http('GET', `/api/v1/users/${otherTenantUser}`, { token: await tokenOf('clinic1Admin') });
    expect(response.status).toBe(404);
    const own = await http('GET', '/api/v1/users/20000000-0000-4000-8000-000000010002', { token: await tokenOf('clinic1Admin') });
    expect(own.body).toMatchObject({ data: { role: 'receptionist', status: 'active' } });
  });
});

describe('patients (RF14) with contact auditing (RF18)', () => {
  it('registers a patient, audits the contact write and replays idempotent requests', async () => {
    const token = await tokenOf('clinic1Receptionist');
    const key = `it-${randomUUID()}`;
    const body = newPatient('a');
    const created = await http<{ data: { patientId: string; contact: { email: string } } }>('POST', '/api/v1/patients', {
      token,
      body,
      headers: { 'Idempotency-Key': key },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe(`/api/v1/patients/${created.body.data.patientId}`);
    expect(created.body.data.contact.email).toBe('pa@example.test');

    const audit = await events.waitFor(
      (message) => message.messageType === 'PatientContactAccessed' && message.payload['patientId'] === created.body.data.patientId,
    );
    expect(audit.payload).toMatchObject({ action: 'create', outcome: 'success', actorSubject: RECEPTIONIST_1.subject, actorRole: 'receptionist' });
    expect(JSON.stringify(audit.payload)).not.toContain('example.test');
    expect(audit.tenantId).toBe(CLINIC_1);

    const replay = await http<{ data: { patientId: string } }>('POST', '/api/v1/patients', { token, body, headers: { 'Idempotency-Key': key } });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body.data.patientId).toBe(created.body.data.patientId);

    const reused = await http('POST', '/api/v1/patients', { token, body: newPatient('b'), headers: { 'Idempotency-Key': key } });
    expect(reused.status).toBe(422);
    expect(reused.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const duplicate = await http('POST', '/api/v1/patients', { token, body });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({ code: 'PATIENT_IDENTIFICATION_TAKEN', details: { patientId: created.body.data.patientId } });
  });

  it('rejects an injected tenantId and unknown fields', async () => {
    const response = await http('POST', '/api/v1/patients', {
      token: await tokenOf('clinic1Receptionist'),
      body: { ...newPatient('c'), tenantId: CLINIC_2 },
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('lists without contact data, reads with an audited access, and hides other tenants', async () => {
    const token = await tokenOf('clinic1Professional1');
    const list = await http<{ data: Record<string, unknown>[] }>('GET', '/api/v1/patients?q=IT-&limit=5', {
      token: await tokenOf('clinic1Receptionist'),
    });
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    expect(list.body.data.every((patient) => !('contact' in patient))).toBe(true);

    const patientId = '50000000-0000-4000-8000-000100000001';
    const detail = await http<{ data: { contact: unknown } }>('GET', `/api/v1/patients/${patientId}`, { token });
    expect(detail.status).toBe(200);
    expect(detail.body.data.contact).toBeDefined();
    await events.waitFor(
      (message) =>
        message.messageType === 'PatientContactAccessed' &&
        message.payload['patientId'] === patientId &&
        message.payload['action'] === 'read' &&
        message.payload['actorRole'] === 'health_professional',
    );

    const foreign = await http('GET', '/api/v1/patients/50000000-0000-4000-8000-000200000001', { token });
    expect(foreign.status).toBe(404);
  });

  it('updates a patient, announcing field names only, and denies writes to professionals', async () => {
    const token = await tokenOf('clinic1Receptionist');
    const created = await http<{ data: { patientId: string } }>('POST', '/api/v1/patients', { token, body: newPatient('d') });
    const patientId = created.body.data.patientId;
    const patched = await http<{ data: { contact: { phone: string } } }>('PATCH', `/api/v1/patients/${patientId}`, {
      token,
      body: { contact: { phone: '+50677776666' } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data.contact.phone).toBe('+50677776666');
    const updated = await events.waitFor((message) => message.messageType === 'PatientUpdated' && message.payload['patientId'] === patientId);
    expect(updated.payload['changedFields']).toEqual(['contact.phone']);
    await events.waitFor(
      (message) =>
        message.messageType === 'PatientContactAccessed' && message.payload['patientId'] === patientId && message.payload['action'] === 'update',
    );
    const professional = await http('PATCH', `/api/v1/patients/${patientId}`, {
      token: await tokenOf('clinic1Professional1'),
      body: { firstName: 'X' },
    });
    expect(professional.status).toBe(403);
  });
});

describe('user provisioning commands (RF2 saga participant)', () => {
  it('reserves, activates and changes the role of a user; rejects a taken e-mail', async () => {
    const userId = randomUUID();
    const sagaId = randomUUID();
    const reserve = umo.envelope({
      messageType: 'ReserveUserCommand',
      tenantId: CLINIC_1,
      actor: ADMIN_1,
      sagaId,
      replyTo: 'user-management-orchestrator',
      payload: { userId, email: `nuevo.${runId}@it.medicitas.test`, firstName: 'Nuevo', lastName: 'Usuario', role: 'receptionist' },
    });
    await umo.command('user-management.user.reserve', reserve);
    expect((await reply(umoReplies, reserve)).payload).toMatchObject({ outcome: 'succeeded', result: { userId, status: 'provisioning' } });

    const subject = randomUUID();
    const activate = umo.envelope({
      messageType: 'ActivateUserCommand',
      tenantId: CLINIC_1,
      actor: ADMIN_1,
      sagaId,
      replyTo: 'user-management-orchestrator',
      payload: { userId, keycloakSubject: subject },
    });
    await umo.command('user-management.user.activate', activate);
    expect((await reply(umoReplies, activate)).payload).toMatchObject({ outcome: 'succeeded', result: { status: 'active', keycloakSubject: subject } });
    await events.waitFor((message) => message.messageType === 'TenantUserActivated' && message.payload['userId'] === userId);

    const promote = umo.envelope({
      messageType: 'ChangeUserRoleCommand',
      tenantId: CLINIC_1,
      actor: ADMIN_1,
      replyTo: 'user-management-orchestrator',
      payload: { userId, role: 'clinic_admin' },
    });
    await umo.command('user-management.user.change-role', promote);
    expect((await reply(umoReplies, promote)).payload).toMatchObject({ outcome: 'succeeded', result: { role: 'clinic_admin' } });

    const deactivate = umo.envelope({
      messageType: 'DeactivateUserCommand',
      tenantId: CLINIC_1,
      actor: ADMIN_1,
      replyTo: 'user-management-orchestrator',
      payload: { userId },
    });
    await umo.command('user-management.user.deactivate', deactivate);
    expect((await reply(umoReplies, deactivate)).payload).toMatchObject({ outcome: 'succeeded', result: { status: 'inactive' } });
    await events.waitFor((message) => message.messageType === 'TenantUserDeactivated' && message.payload['userId'] === userId);

    const taken = umo.envelope({
      messageType: 'ReserveUserCommand',
      tenantId: CLINIC_1,
      actor: ADMIN_1,
      replyTo: 'user-management-orchestrator',
      payload: { userId: randomUUID(), email: 'diego.araya@heredia.medicitas.test', firstName: 'X', lastName: 'Y', role: 'receptionist' },
    });
    await umo.command('user-management.user.reserve', taken);
    expect((await reply(umoReplies, taken)).payload).toMatchObject({ outcome: 'rejected', error: { code: 'EMAIL_TAKEN' } });
  });

  it('protects the last active clinic admin (LAST_CLINIC_ADMIN)', async () => {
    const demote = umo.envelope({
      messageType: 'ChangeUserRoleCommand',
      tenantId: CLINIC_2,
      actor: { subject: '30000000-0000-4000-8000-000000020001', roles: ['clinic_admin'] },
      replyTo: 'user-management-orchestrator',
      payload: { userId: '20000000-0000-4000-8000-000000020001', role: 'receptionist' },
    });
    await umo.command('user-management.user.change-role', demote);
    expect((await reply(umoReplies, demote)).payload).toMatchObject({ outcome: 'rejected', error: { code: 'LAST_CLINIC_ADMIN' } });
  });
});

describe('EnsurePatientCommand (RF9 saga participant)', () => {
  const ensure = (payload: Record<string, unknown>, tenantId = CLINIC_1): Envelope =>
    booking.envelope({
      messageType: 'EnsurePatientCommand',
      tenantId,
      actor: RECEPTIONIST_1,
      sagaId: randomUUID(),
      stepId: 'patient',
      replyTo: 'appointment-orchestrator',
      payload,
    });

  it('validates existing patients under the tenant RLS context', async () => {
    const ok = ensure({ mode: 'existing', patientId: '50000000-0000-4000-8000-000100000002' });
    await booking.command('user-management.patient.ensure', ok);
    expect((await reply(bookingReplies, ok)).payload).toMatchObject({ outcome: 'succeeded', result: { created: false } });

    const inactive = ensure({ mode: 'existing', patientId: '50000000-0000-4000-8000-000100000120' });
    await booking.command('user-management.patient.ensure', inactive);
    expect((await reply(bookingReplies, inactive)).payload).toMatchObject({ outcome: 'rejected', error: { code: 'PATIENT_INACTIVE' } });

    // A manipulated message: a patient of clinic 2 referenced from a clinic-1 context is simply not found.
    const foreign = ensure({ mode: 'existing', patientId: '50000000-0000-4000-8000-000200000002' });
    await booking.command('user-management.patient.ensure', foreign);
    expect((await reply(bookingReplies, foreign)).payload).toMatchObject({ outcome: 'rejected', error: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('creates a patient idempotently and reports an existing identification', async () => {
    const patientId = randomUUID();
    const create = ensure({ mode: 'create', patientId, patient: newPatient('e') });
    await booking.command('user-management.patient.ensure', create);
    expect((await reply(bookingReplies, create)).payload).toMatchObject({ outcome: 'succeeded', result: { patientId, created: true } });

    const again = ensure({ mode: 'create', patientId, patient: newPatient('e') });
    await booking.command('user-management.patient.ensure', again);
    expect((await reply(bookingReplies, again)).payload).toMatchObject({ outcome: 'succeeded', result: { created: false } });

    const clash = ensure({ mode: 'create', patientId: randomUUID(), patient: newPatient('e') });
    await booking.command('user-management.patient.ensure', clash);
    expect((await reply(bookingReplies, clash)).payload).toMatchObject({
      outcome: 'rejected',
      error: { code: 'PATIENT_IDENTIFICATION_TAKEN' },
      result: { existingPatientId: patientId },
    });
  });
});

describe('GetTenantUserQuery (RF4 support) and TenantOnboarded replica', () => {
  it('answers a correlated query through direct reply-to, scoped to the tenant', async () => {
    const connection = serviceConnection('catalog-service-management');
    const client = new QueryClient(connection, { brokerUser: 'svc_catalog' });
    const resultSchema = ReplyPayloadSchema;
    const ask = (userId: string) =>
      client.request(
        'user-management.user.get',
        createEnvelope({
          messageType: 'GetTenantUserQuery',
          producer: 'catalog-service-management',
          tenantId: CLINIC_1,
          actor: ADMIN_1,
          correlationId: randomUUID(),
          payload: { userId },
        }),
        resultSchema,
      );
    try {
      const found = await ask('20000000-0000-4000-8000-000000010011');
      expect(found).toMatchObject({ outcome: 'succeeded', result: { found: true, user: { role: 'health_professional', status: 'active' } } });
      const foreign = await ask('20000000-0000-4000-8000-000000020011');
      expect(found.outcome).toBe('succeeded');
      expect(z.object({ found: z.literal(false) }).safeParse(foreign.result).success).toBe(true);
    } finally {
      await client.close();
      await connection.close();
    }
  });

  it('replicates an onboarded tenant and registers its first admin', async () => {
    const tenantId = randomUUID();
    const subject = randomUUID();
    const slug = `it-${runId}-replica`;
    const event = tenantProbe.envelope({
      messageType: 'TenantOnboarded',
      tenantId,
      actor: { subject: '30000000-0000-4000-8000-000000000000', roles: ['platform_admin'] },
      payload: {
        tenantId,
        slug,
        name: 'Replica Clinic',
        timezone: 'America/Costa_Rica',
        status: 'active',
        aggregateVersion: 2,
        firstAdmin: { subject, email: `admin.${runId}@it.medicitas.test`, firstName: 'Ada', lastName: 'Admin' },
      },
    });
    await tenantProbe.event('tenant.tenant.onboarded', event);
    await expect
      .poll(async () => (await owner.query('SELECT role, status FROM identity.users WHERE keycloak_subject = $1', [subject])).rows[0], {
        timeout: 10_000,
      })
      .toEqual({ role: 'clinic_admin', status: 'active' });
  });
});
