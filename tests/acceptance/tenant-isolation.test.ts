import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withTransaction } from '@medicitas/kernel';
import { EXCHANGES, type Envelope } from '@medicitas/messaging';
import { runtimePool } from '../support/database.js';
import { MessageTap, ServiceProbe } from '../support/services.js';
import { api, availability, book, codeOf, expectStatus, localDate, type Appointment } from './support/api.js';
import { insertPastAppointment } from './support/clock.js';
import { createPatient, createProfessional, seededToken, tokenOf, type TestProfessional } from './support/fixture.js';

/**
 * Acceptance criterion 4 and invariant I5 (no data of one clinic is reachable from another, by any route
 * or combination of parameters). The victim is the run clinic A; attackers are
 * authenticated staff of the seeded clinics. Every attempt is a deliberate leak attempt: foreign ids
 * in paths, manipulated query parameters, injected tenant headers/body fields, foreign cursors,
 * foreign mutations and a cache-key collision. The engine-level RLS is checked last.
 */
const fixture = inject('acceptance');
const DATE = localDate(fixture.timezone, 4);
const CLINIC_2 = '10000000-0000-4000-8000-000000000002';

let professional: TestProfessional;
let victimToken: string;
let victimAdmin: string;
let attacker: string; // clinic 2 receptionist
let attackerAdmin: string; // clinic 2 admin
let patientId: string;
let appointment: Appointment;
let attendedId: string;
let blockId: string;
let patientsCursor: string | null;

beforeAll(async () => {
  [victimToken, victimAdmin, attacker, attackerAdmin] = await Promise.all([
    tokenOf(fixture.receptionists[0]),
    tokenOf(fixture.admin),
    seededToken('clinic2Receptionist'),
    seededToken('clinic2Admin'),
  ]);
  professional = await createProfessional(fixture, { name: 'Dr. Isolation' });
  patientId = await createPatient(victimToken, 'Victim');
  await createPatient(victimToken, 'Victim'); // a second page for the cursor test
  const slots = expectStatus(await availability(victimToken, professional.professionalId, fixture.serviceId, DATE), 200).body.data.slots;
  appointment = expectStatus(
    await book(victimToken, { patientId, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: String(slots[0]?.startAt) }),
    201,
  ).body.data;
  const past = await insertPastAppointment({
    tenantId: fixture.tenantId,
    professionalId: professional.professionalId,
    serviceId: fixture.serviceId,
    patientId,
    bookedBy: fixture.receptionists[0].subject,
    daysAgo: 3,
    localTime: '10:00',
  });
  attendedId = past.appointmentId;
  const professionalToken = await tokenOf(professional.member);
  expectStatus(await api('POST', `/api/v1/appointments/${attendedId}/outcome`, { token: professionalToken, body: { outcome: 'attended' } }), 200);
  expectStatus(await api('POST', `/api/v1/appointments/${attendedId}/clinical-note`, { token: professionalToken, body: { content: 'Confidential clinical data' } }), 201);
  blockId = expectStatus(
    await api<{ data: { blockId: string } }>('POST', `/api/v1/professionals/${professional.professionalId}/calendar-blocks`, {
      token: victimAdmin,
      body: { startAt: `${localDate(fixture.timezone, 30)}T08:00:00-06:00`, endAt: `${localDate(fixture.timezone, 30)}T12:00:00-06:00`, reason: 'other' },
    }),
    201,
  ).body.data.blockId;
  patientsCursor = expectStatus(await api<{ page: { nextCursor: string | null } }>('GET', '/api/v1/patients?limit=1', { token: victimToken }), 200).body.page.nextCursor;
  // Warm the victim's availability cache entry so the cross-tenant attempt below would hit it if keys were not tenant-scoped.
  await availability(victimToken, professional.professionalId, fixture.serviceId, DATE);
  await availability(victimToken, professional.professionalId, fixture.serviceId, DATE);
});

describe('foreign ids in paths answer 404 RESOURCE_NOT_FOUND (existence is never revealed)', () => {
  it('reads of every resource type of clinic A from clinic 2', async () => {
    const paths = [
      `/api/v1/patients/${patientId}`,
      `/api/v1/appointments/${appointment.appointmentId}`,
      `/api/v1/appointments/${attendedId}/clinical-note`,
      `/api/v1/professionals/${professional.professionalId}`,
      `/api/v1/professionals/${professional.professionalId}/services`,
      `/api/v1/professionals/${professional.professionalId}/weekly-schedule`,
      `/api/v1/services/${fixture.serviceId}`,
      `/api/v1/availability?professionalId=${professional.professionalId}&serviceId=${fixture.serviceId}&date=${DATE}`,
    ];
    for (const path of paths) {
      const result = await api('GET', path, { token: attacker });
      expect([path, result.status, codeOf(result)]).toEqual([path, 404, 'RESOURCE_NOT_FOUND']);
    }
    const user = await api('GET', `/api/v1/users/${fixture.receptionists[0].userId}`, { token: attackerAdmin });
    expect([user.status, codeOf(user)]).toEqual([404, 'RESOURCE_NOT_FOUND']);
  });

  it('a 404 for a foreign id is indistinguishable from a 404 for an id that does not exist anywhere', async () => {
    const foreign = await api<Record<string, unknown>>('GET', `/api/v1/patients/${patientId}`, { token: attacker });
    const missing = await api<Record<string, unknown>>('GET', '/api/v1/patients/00000000-0000-4000-8000-00000000dead', { token: attacker });
    const strip = (body: Record<string, unknown>): Record<string, unknown> => ({ ...body, correlationId: undefined, detail: undefined });
    expect(strip(foreign.body)).toEqual(strip(missing.body));
  });

  it('per-patient and per-professional views return nothing instead of foreign data', async () => {
    const history = expectStatus(await api<{ data: unknown[] }>('GET', `/api/v1/patients/${patientId}/appointments`, { token: attacker }), 200);
    expect(history.body.data).toEqual([]);
    const blocks = await api<{ data?: unknown[] }>('GET', `/api/v1/professionals/${professional.professionalId}/calendar-blocks`, { token: attacker });
    expect(blocks.status === 404 || (blocks.status === 200 && blocks.body.data?.length === 0)).toBe(true);
    const counts = await api<{ data?: { total: number } }>('GET', `/api/v1/reports/appointment-status-counts?from=${DATE}&to=${DATE}&professionalId=${professional.professionalId}`, {
      token: attacker,
    });
    expect(counts.status === 404 || (counts.status === 200 && counts.body.data?.total === 0)).toBe(true);
    const audit = expectStatus(await api<{ data: unknown[] }>('GET', `/api/v1/audit-log?patientId=${patientId}`, { token: attackerAdmin }), 200);
    expect(audit.body.data).toEqual([]);
    const agenda = await api<{ data?: { items: unknown[] } }>('GET', `/api/v1/agenda?date=${DATE}&professionalId=${professional.professionalId}`, { token: attacker });
    expect(agenda.status === 404 || (agenda.status === 200 && agenda.body.data?.items.length === 0)).toBe(true);
    const conflicts = await api<{ data?: unknown[] }>('GET', `/api/v1/schedule-conflicts?professionalId=${professional.professionalId}`, { token: attacker });
    expect(conflicts.status === 404 || (conflicts.status === 200 && conflicts.body.data?.length === 0)).toBe(true);
  });
});

describe('list routes with manipulated parameters never include clinic A data', () => {
  it('lists of clinic 2 contain none of clinic A ids', async () => {
    const lists = await Promise.all([
      api<{ data: { patientId: string }[] }>('GET', `/api/v1/patients?limit=100&q=Victim`, { token: attacker }),
      api<{ data: { professionalId: string }[] }>(`GET`, `/api/v1/professionals?limit=100&serviceId=${fixture.serviceId}`, { token: attacker }),
      api<{ data: { serviceId: string }[] }>('GET', `/api/v1/services?limit=100&specialtyId=${fixture.specialtyId}`, { token: attacker }),
      api<{ data: { userId: string }[] }>('GET', '/api/v1/users?limit=100&q=Reception', { token: attackerAdmin }),
      api<{ data: { items: { appointmentId: string }[] } }>('GET', `/api/v1/agenda?date=${DATE}`, { token: attacker }),
    ]);
    const serialized = JSON.stringify(lists.map((list) => list.body));
    for (const id of [patientId, professional.professionalId, fixture.serviceId, fixture.receptionists[0].userId, appointment.appointmentId]) {
      expect(serialized).not.toContain(id);
    }
  });

  it('rejects a tenantId smuggled in the query string or the body (400) and ignores tenant headers', async () => {
    const query = await api('GET', `/api/v1/patients?tenantId=${fixture.tenantId}`, { token: attacker });
    expect([query.status, codeOf(query)]).toEqual([400, 'VALIDATION_FAILED']);
    const body = await api('POST', '/api/v1/patients', {
      token: attacker,
      body: { tenantId: fixture.tenantId, identificationType: 'passport', identificationNumber: 'LEAK-1', firstName: 'X', lastName: 'Y', birthDate: '1990-01-01' },
    });
    expect([body.status, codeOf(body)]).toEqual([400, 'VALIDATION_FAILED']);
    const header = await api('GET', `/api/v1/patients/${patientId}`, { token: attacker, headers: { 'X-Tenant-Id': fixture.tenantId, 'X-User-Role': 'clinic_admin' } });
    expect(header.status).toBe(404);
    const me = expectStatus(await api<{ data: { tenantId: string } }>('GET', '/api/v1/me', { token: attacker, headers: { 'X-Tenant-Id': fixture.tenantId } }), 200);
    expect(me.body.data.tenantId).toBe(CLINIC_2);
  });

  it('a cursor taken from clinic A list does not open clinic A rows to clinic 2', async () => {
    expect(patientsCursor).not.toBeNull();
    const result = await api<{ data?: { patientId: string }[] }>('GET', `/api/v1/patients?limit=100&cursor=${encodeURIComponent(String(patientsCursor))}`, { token: attacker });
    expect([200, 400]).toContain(result.status);
    expect(JSON.stringify(result.body)).not.toContain(patientId);
  });
});

describe('foreign mutations are refused and leave clinic A untouched', () => {
  it('cancel, reschedule, outcome, note, patient update, schedule, block removal and user deactivation from clinic 2', async () => {
    const [free] = expectStatus(await availability(victimToken, professional.professionalId, fixture.serviceId, DATE), 200).body.data.slots;
    const attempts = [
      api('POST', `/api/v1/appointments/${appointment.appointmentId}/cancel`, { token: attacker, body: { reason: 'leak' } }),
      api('POST', `/api/v1/appointments/${appointment.appointmentId}/reschedule`, { token: attacker, body: { startAt: free?.startAt } }),
      api('POST', `/api/v1/appointments/${appointment.appointmentId}/outcome`, { token: attacker, body: { outcome: 'no_show' } }),
      api('PATCH', `/api/v1/patients/${patientId}`, { token: attacker, body: { firstName: 'Hacked' } }),
      api('PUT', `/api/v1/professionals/${professional.professionalId}/weekly-schedule`, { token: attackerAdmin, body: { blocks: [] } }),
      api('DELETE', `/api/v1/professionals/${professional.professionalId}/calendar-blocks/${blockId}`, { token: attackerAdmin }),
      api('PATCH', `/api/v1/services/${fixture.serviceId}`, { token: attackerAdmin, body: { durationMinutes: 60 } }),
      api('POST', `/api/v1/users/${fixture.receptionists[1].userId}/deactivate`, { token: attackerAdmin, idempotencyKey: true }),
      book(attacker, { patientId, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: String(free?.startAt) }),
    ];
    const results = await Promise.all(attempts);
    expect(results.map((result) => result.status)).toEqual(results.map(() => 404));

    const intact = expectStatus(await api<{ data: Appointment }>('GET', `/api/v1/appointments/${appointment.appointmentId}`, { token: victimToken }), 200);
    expect(intact.body.data.status).toBe('booked');
    expect(expectStatus(await api<{ data: { firstName: string } }>('GET', `/api/v1/patients/${patientId}`, { token: victimToken }), 200).body.data.firstName).toBe('Victim');
    expect(expectStatus(await api<{ data: { durationMinutes: number } }>('GET', `/api/v1/services/${fixture.serviceId}`, { token: victimToken }), 200).body.data.durationMinutes).toBe(30);
    const schedule = expectStatus(await api<{ data: { blocks: unknown[] } }>('GET', `/api/v1/professionals/${professional.professionalId}/weekly-schedule`, { token: victimToken }), 200);
    expect(schedule.body.data.blocks.length).toBeGreaterThan(0);
    const blocks = expectStatus(
      await api<{ data: { blockId: string; status: string }[] }>(
        'GET',
        `/api/v1/professionals/${professional.professionalId}/calendar-blocks?from=${localDate(fixture.timezone, 29)}&to=${localDate(fixture.timezone, 31)}`,
        { token: victimToken },
      ),
      200,
    );
    expect(blocks.body.data.find((block) => block.blockId === blockId)?.status).toBe('active');
    const users = expectStatus(await api<{ data: { userId: string; status: string }[] }>('GET', '/api/v1/users?limit=100', { token: victimAdmin }), 200);
    expect(users.body.data.find((user) => user.userId === fixture.receptionists[1].userId)?.status).toBe('active');
  });

  it('even a clinic admin of another clinic cannot read clinic A tenant record (control plane)', async () => {
    const result = await api('GET', `/api/v1/tenants/${fixture.tenantId}`, { token: attackerAdmin });
    expect(result.status).toBe(403);
  });
});

describe('RabbitMQ messages with an altered tenant context', () => {
  let probe: ServiceProbe;
  let replies: MessageTap;
  beforeAll(async () => {
    // Publishes with the real broker identity of the booking orchestrator; replies are observed through a copy queue.
    probe = new ServiceProbe('appointment-orchestrator');
    await probe.ready();
    replies = await MessageTap.open([{ exchange: EXCHANGES.replies, routingKey: 'appointment-orchestrator' }]);
  });
  afterAll(async () => {
    await replies.close();
    await probe.close();
  });

  const ensurePatient = (tenantId: string): Envelope =>
    probe.envelope({
      messageType: 'EnsurePatientCommand',
      tenantId,
      actor: { subject: randomUUID(), roles: ['receptionist'] },
      sagaId: randomUUID(),
      stepId: 'patient',
      replyTo: 'appointment-orchestrator',
      payload: { mode: 'existing', patientId },
    });

  it('a command carrying another tenant cannot reach clinic A data; the same command in clinic A context can', async () => {
    const forged = ensurePatient(CLINIC_2);
    const legitimate = ensurePatient(fixture.tenantId);
    await probe.command('user-management.patient.ensure', forged);
    await probe.command('user-management.patient.ensure', legitimate);
    const forgedReply = await replies.waitFor((message) => message.commandId === forged.messageId, 15_000);
    const legitimateReply = await replies.waitFor((message) => message.commandId === legitimate.messageId, 15_000);
    expect(forgedReply.payload).toMatchObject({ outcome: 'rejected', error: { code: 'RESOURCE_NOT_FOUND' } });
    expect(legitimateReply.payload).toMatchObject({ outcome: 'succeeded' });
  });
});

describe('engine-level isolation (Row-Level Security)', () => {
  const scheduler = runtimePool('sch', 'medicitas_scheduler');
  const users = runtimePool('um', 'medicitas_user');
  afterAll(async () => {
    await Promise.all([scheduler.end(), users.end()]);
  });

  it('a runtime role under clinic 2 context sees zero clinic A rows even when filtering by clinic A id explicitly', async () => {
    const appointments = await withTransaction(scheduler, { tenantId: CLINIC_2, actorSubject: null, dbRole: 'sch_system', isolation: 'READ COMMITTED' }, async (client) =>
      Number((await client.query<{ n: string }>('SELECT count(*) AS n FROM appointments WHERE tenant_id = $1', [fixture.tenantId])).rows[0]?.n),
    );
    expect(appointments).toBe(0);
    const patients = await withTransaction(users, { tenantId: CLINIC_2, actorSubject: null, dbRole: 'um_system', isolation: 'READ COMMITTED' }, async (client) =>
      Number((await client.query<{ n: string }>('SELECT count(*) AS n FROM patients WHERE tenant_id = $1', [fixture.tenantId])).rows[0]?.n),
    );
    expect(patients).toBe(0);
    const own = await withTransaction(scheduler, { tenantId: fixture.tenantId, actorSubject: null, dbRole: 'sch_system', isolation: 'READ COMMITTED' }, async (client) =>
      Number((await client.query<{ n: string }>('SELECT count(*) AS n FROM appointments WHERE tenant_id = $1', [fixture.tenantId])).rows[0]?.n),
    );
    expect(own).toBeGreaterThan(0);
  });

  it('foreign rows are invisible to writes (USING) and rows for another tenant cannot be created (WITH CHECK)', async () => {
    const update = withTransaction(users, { tenantId: CLINIC_2, actorSubject: null, dbRole: 'um_receptionist', isolation: 'READ COMMITTED' }, (client) =>
      client.query(`UPDATE patients SET first_name = 'Hacked' WHERE id = $1`, [patientId]).then((result) => result.rowCount),
    );
    await expect(update).resolves.toBe(0);
    const insert = withTransaction(users, { tenantId: CLINIC_2, actorSubject: null, dbRole: 'um_system', isolation: 'READ COMMITTED' }, (client) =>
      client.query(
        `INSERT INTO patients (id, tenant_id, identification_type, identification_number, first_name, last_name, birth_date)
         VALUES (gen_random_uuid(), $1, 'passport', 'RLS-LEAK', 'X', 'Y', '1990-01-01')`,
        [fixture.tenantId],
      ),
    );
    await expect(insert).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('row-level security') });
  });
});
