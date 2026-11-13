import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withTransaction } from '@medicitas/kernel';
import { ownerPool, runtimePool } from '../support/database.js';
import { api, eventually, expectStatus } from './support/api.js';
import { insertPastAppointment } from './support/clock.js';
import { createPatient, createProfessional, tokenOf, type TestProfessional } from './support/fixture.js';

/**
 * RF18 (append-only log of every read and write of clinical notes and patient contact data, with who,
 * what, which patient and when), RF19 (clinic admin only, filters by user, patient and date range) and
 * I6 (the application cannot modify or delete the log — enforced by the engine), against the
 * containers. Each audited request carries its own X-Correlation-Id, which must reach the audit row.
 */
const fixture = inject('acceptance');
const NOTE = 'Nota confidencial: hipertensión controlada.';
const PHONE = '+50611112222';

interface AuditEntry {
  readonly auditId: string;
  readonly occurredAt: string;
  readonly actorSubject: string;
  readonly actorRole: string;
  readonly patientId: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly correlationId: string;
  readonly sourceService: string;
}

let professional: TestProfessional;
let otherProfessional: TestProfessional;
let admin: string;
let receptionist: string;
let professionalToken: string;
let patientId: string;
let appointmentId: string;
const correlation: Record<string, string> = {};
const startedAt = new Date(Date.now() - 1_000).toISOString();

const auditOf = async (query: string): Promise<AuditEntry[]> =>
  expectStatus(await api<{ data: AuditEntry[] }>('GET', `/api/v1/audit-log?${query}`, { token: admin }), 200, 'RF19').body.data;

beforeAll(async () => {
  [admin, receptionist] = await Promise.all([tokenOf(fixture.admin), tokenOf(fixture.receptionists[0])]);
  [professional, otherProfessional] = await Promise.all([createProfessional(fixture, { name: 'Dr. Bitácora' }), createProfessional(fixture, { name: 'Dra. Ajena' })]);
  professionalToken = await tokenOf(professional.member);
  patientId = await createPatient(receptionist, 'Auditado');
  const past = await insertPastAppointment({
    tenantId: fixture.tenantId,
    professionalId: professional.professionalId,
    serviceId: fixture.serviceId,
    patientId,
    bookedBy: fixture.receptionists[0].subject,
    daysAgo: 1,
    localTime: '14:00',
  });
  appointmentId = past.appointmentId;
  expectStatus(await api('POST', `/api/v1/appointments/${appointmentId}/outcome`, { token: professionalToken, body: { outcome: 'attended' } }), 200);
});

describe('RF18: every read and write of clinical notes is audited, including denied attempts', () => {
  it('records the author write and read, and the denied reads/writes of other users', async () => {
    const created = await api('POST', `/api/v1/appointments/${appointmentId}/clinical-note`, { token: professionalToken, body: { content: NOTE } });
    expect(created.status).toBe(201);
    correlation['noteCreate'] = created.correlationId;
    const read = await api('GET', `/api/v1/appointments/${appointmentId}/clinical-note`, { token: professionalToken });
    expect(read.status).toBe(200);
    correlation['noteRead'] = read.correlationId;
    const deniedReception = await api('GET', `/api/v1/appointments/${appointmentId}/clinical-note`, { token: receptionist });
    const deniedOther = await api('POST', `/api/v1/appointments/${appointmentId}/clinical-note`, { token: await tokenOf(otherProfessional.member), body: { content: 'intruso' } });
    const deniedAdmin = await api('GET', `/api/v1/appointments/${appointmentId}/clinical-note`, { token: admin });
    expect([deniedReception.status, deniedOther.status, deniedAdmin.status]).toEqual([403, 403, 403]);
    correlation['deniedReception'] = deniedReception.correlationId;
    correlation['deniedOther'] = deniedOther.correlationId;

    const entries = await auditOf(`patientId=${patientId}&resourceType=clinical_note&limit=100`);
    const pick = (id: string): AuditEntry | undefined => entries.find((entry) => entry.correlationId === id);
    expect(pick(String(correlation['noteCreate']))).toMatchObject({ action: 'create', outcome: 'success', actorSubject: professional.member.subject, actorRole: 'health_professional', patientId });
    expect(pick(String(correlation['noteRead']))).toMatchObject({ action: 'read', outcome: 'success', actorSubject: professional.member.subject });
    expect(pick(String(correlation['deniedReception']))).toMatchObject({ action: 'read', outcome: 'denied', actorRole: 'receptionist', actorSubject: fixture.receptionists[0].subject });
    expect(pick(String(correlation['deniedOther']))).toMatchObject({ action: 'create', outcome: 'denied', actorSubject: otherProfessional.member.subject });
    expect(entries.filter((entry) => entry.outcome === 'denied' && entry.actorRole === 'clinic_admin')).toHaveLength(1);
  });

  it('never copies the clinical content into the log', async () => {
    const entries = await auditOf(`patientId=${patientId}&limit=100`);
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain('hipertensión');
  });
});

describe('RF18: patient contact data reads and writes are audited (user-management → outbox → scheduler)', () => {
  it('records the read of the patient record and the contact update with the request correlation id', async () => {
    const read = await api('GET', `/api/v1/patients/${patientId}`, { token: receptionist });
    expect(read.status).toBe(200);
    const update = await api('PATCH', `/api/v1/patients/${patientId}`, { token: receptionist, body: { contact: { phone: PHONE } } });
    expect(update.status).toBe(200);
    const entries = await eventually(async () => {
      const found = await auditOf(`patientId=${patientId}&resourceType=patient_contact&limit=100`);
      const ids = new Set(found.map((entry) => entry.correlationId));
      return ids.has(read.correlationId) && ids.has(update.correlationId) ? found : undefined;
    }, 20_000, 300, 'patient contact audit rows');
    expect(entries.find((entry) => entry.correlationId === read.correlationId)).toMatchObject({ action: 'read', outcome: 'success', sourceService: 'user-management', actorRole: 'receptionist' });
    expect(entries.find((entry) => entry.correlationId === update.correlationId)).toMatchObject({ action: 'update', outcome: 'success', sourceService: 'user-management' });
    expect(entries.some((entry) => entry.action === 'create')).toBe(true); // the registration in beforeAll
    expect(JSON.stringify(entries)).not.toContain(PHONE);
  });
});

describe('RF19: queryable by the clinic admin only, with filters and pagination', () => {
  it('filters by user, by patient and by date range', async () => {
    const byActor = await auditOf(`actorSubject=${professional.member.subject}&limit=100`);
    expect(byActor.length).toBeGreaterThanOrEqual(2);
    expect(new Set(byActor.map((entry) => entry.actorSubject))).toEqual(new Set([professional.member.subject]));
    const byPatient = await auditOf(`patientId=${patientId}&limit=100`);
    expect(new Set(byPatient.map((entry) => entry.patientId))).toEqual(new Set([patientId]));
    const inRange = await auditOf(`patientId=${patientId}&from=${encodeURIComponent(startedAt)}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}&limit=100`);
    expect(inRange.length).toBe(byPatient.length);
    expect(await auditOf(`patientId=${patientId}&to=${encodeURIComponent(startedAt)}`)).toEqual([]);
    expect(await auditOf(`patientId=${patientId}&from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).toEqual([]);
    const reads = await auditOf(`patientId=${patientId}&action=read&limit=100`);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((entry) => entry.action === 'read')).toBe(true);
    const occurred = byPatient.map((entry) => new Date(entry.occurredAt).getTime());
    expect([...occurred].sort((a, b) => b - a)).toEqual(occurred); // newest first
  });

  it('paginates with a keyset cursor without duplicates or gaps', async () => {
    const all = await auditOf(`patientId=${patientId}&limit=100`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: AuditEntry[]; page: { nextCursor: string | null } } = expectStatus(
        await api<{ data: AuditEntry[]; page: { nextCursor: string | null } }>(
          'GET',
          `/api/v1/audit-log?patientId=${patientId}&limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
          { token: admin },
        ),
        200,
      ).body;
      seen.push(...page.data.map((entry) => entry.auditId));
      cursor = page.page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(all.map((entry) => entry.auditId));
  });

  it('is forbidden to reception and professionals', async () => {
    expect((await api('GET', '/api/v1/audit-log', { token: receptionist })).status).toBe(403);
    expect((await api('GET', '/api/v1/audit-log', { token: professionalToken })).status).toBe(403);
  });
});

describe('I6: the audit log is append-only at engine level', () => {
  const runtime = runtimePool('sch', 'medicitas_scheduler');
  const owner = ownerPool('sch', 'medicitas_scheduler');
  afterAll(async () => {
    await Promise.all([runtime.end(), owner.end()]);
  });

  for (const dbRole of ['sch_clinic_admin', 'sch_receptionist', 'sch_professional', 'sch_system']) {
    it(`${dbRole} (runtime) cannot UPDATE, DELETE or TRUNCATE audit rows`, async () => {
      for (const sql of [`UPDATE audit_log SET outcome = 'success' WHERE patient_id = $1`, 'DELETE FROM audit_log WHERE patient_id = $1', 'TRUNCATE audit_log']) {
        const attempt = withTransaction(runtime, { tenantId: fixture.tenantId, actorSubject: professional.member.subject, dbRole, isolation: 'READ COMMITTED' }, (client) =>
          client.query(sql, sql.startsWith('TRUNCATE') ? [] : [patientId]),
        );
        await expect(attempt).rejects.toMatchObject({ code: '42501' });
      }
    });
  }

  it('not even the schema owner can rewrite history', async () => {
    await expect(owner.query('DELETE FROM scheduling.audit_log WHERE patient_id = $1', [patientId])).rejects.toMatchObject({ code: '42501' });
    await expect(owner.query(`UPDATE scheduling.audit_log SET outcome = 'success' WHERE patient_id = $1`, [patientId])).rejects.toMatchObject({ code: '42501' });
    const denied = (await auditOf(`patientId=${patientId}&limit=100`)).filter((entry) => entry.outcome === 'denied');
    expect(denied.length).toBeGreaterThanOrEqual(3); // the denied attempts are still there
  });
});
