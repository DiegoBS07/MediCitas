import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@medicitas/kernel';
import { EXCHANGES } from '@medicitas/messaging';
import { startScheduler, type SchedulerService } from '../../../application-plane/scheduler-management/src/service.js';
import { CLINIC_1, ownerPool, runtimePool } from '../../support/database.js';
import { MessageTap, ServiceProbe, httpClient } from '../../support/services.js';
import { localDate, schedulerConfig } from '../../support/scheduler.js';
import { tokenOf } from '../../support/tokens.js';

const TZ = 'America/Costa_Rica';
const PROFESSIONAL_1 = '42000000-0000-4000-8000-000000010001';
const PROFESSIONAL_2 = '42000000-0000-4000-8000-000000010002';
const GENERAL_CONSULTATION = '41000000-0000-4000-8000-000000010001';
const ANDRES = '30000000-0000-4000-8000-000000010011';
const owner = ownerPool('sch', 'medicitas_scheduler');
const runtime = runtimePool('sch', 'medicitas_scheduler');
const patientId = randomUUID();

let scheduler: SchedulerService;
let http: ReturnType<typeof httpClient>;
let events: MessageTap;
let userEvents: ServiceProbe;
let attended: { readonly id: string; readonly date: string };
let pending: { readonly id: string; readonly date: string };

/**
 * A past booked appointment of the seeded professional 1 (Mon–Fri 08:00–12:00 local), inserted with
 * the owner role far before the seed window (400–700 days ago) on a random 15-minute slot, so runs
 * never collide with demo data or with each other. Every production trigger still validates it.
 */
async function insertPastAppointment(): Promise<{ readonly id: string; readonly date: string }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const date = localDate(TZ, -(400 + Math.floor(Math.random() * 300)));
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const minutes = 8 * 60 + 15 * Math.floor(Math.random() * 15);
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const id = randomUUID();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path TO scheduling, app, public');
      await client.query(
        `INSERT INTO appointments (id, tenant_id, patient_id, professional_id, service_id, slot, status, booked_by_subject)
         VALUES ($1, $2, $3, $4, $5, tstzrange($6::timestamptz, $6::timestamptz + interval '30 minutes', '[)'), 'booked', $7)`,
        [id, CLINIC_1, patientId, PROFESSIONAL_1, GENERAL_CONSULTATION, `${date}T${time}:00-06:00`, '30000000-0000-4000-8000-000000010002'],
      );
      await client.query('COMMIT');
      return { id, date };
    } catch {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
  throw new Error('could not place a past appointment');
}

beforeAll(async () => {
  scheduler = await startScheduler(schedulerConfig());
  http = httpClient(scheduler.port);
  events = await MessageTap.open([{ exchange: EXCHANGES.events, routingKey: 'scheduler.#' }]);
  userEvents = new ServiceProbe('user-management');
  await userEvents.ready();
  attended = await insertPastAppointment();
  pending = await insertPastAppointment();
});

afterAll(async () => {
  await Promise.all([owner.end(), runtime.end()]);
  await events.close();
  await userEvents.close();
  await scheduler.stop();
});

describe('RF12 outcome and RF15 clinical notes with RF18 auditing', () => {
  it('records the outcome of a past appointment (professionals may do it)', async () => {
    const response = await http<{ data: { status: string; outcome: { recordedBy: string } } }>(
      'POST',
      `/api/v1/appointments/${attended.id}/outcome`,
      { token: await tokenOf('clinic1Professional1'), body: { outcome: 'attended' } },
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: 'attended', outcome: { recordedBy: ANDRES } });
    const again = await http('POST', `/api/v1/appointments/${attended.id}/outcome`, { token: await tokenOf('clinic1Receptionist'), body: { outcome: 'no_show' } });
    expect(again.body).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('lets only the appointment professional write and read the note; denied attempts are audited', async () => {
    const other = await http('POST', `/api/v1/appointments/${attended.id}/clinical-note`, {
      token: await tokenOf('clinic1Professional2'),
      body: { content: 'Should never be stored' },
    });
    expect(other.status).toBe(403);
    const reception = await http('POST', `/api/v1/appointments/${attended.id}/clinical-note`, {
      token: await tokenOf('clinic1Receptionist'),
      body: { content: 'x' },
    });
    expect(reception.status).toBe(403);

    const created = await http<{ data: Record<string, unknown> }>('POST', `/api/v1/appointments/${attended.id}/clinical-note`, {
      token: await tokenOf('clinic1Professional1'),
      body: { content: 'Patient stable. Follow-up in two weeks.' },
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ appointmentId: attended.id, patientId, authorSubject: ANDRES });
    expect(created.body.data).not.toHaveProperty('content');
    const event = await events.waitFor((message) => message.messageType === 'ClinicalNoteAdded' && message.payload['appointmentId'] === attended.id);
    expect(JSON.stringify(event.payload)).not.toContain('Patient stable');

    const duplicate = await http('POST', `/api/v1/appointments/${attended.id}/clinical-note`, {
      token: await tokenOf('clinic1Professional1'),
      body: { content: 'second' },
    });
    expect(duplicate.body).toMatchObject({ code: 'CLINICAL_NOTE_EXISTS' });

    const read = await http<{ data: { content: string } }>('GET', `/api/v1/appointments/${attended.id}/clinical-note`, {
      token: await tokenOf('clinic1Professional1'),
    });
    expect(read.body.data.content).toBe('Patient stable. Follow-up in two weeks.');
    expect((await http('GET', `/api/v1/appointments/${attended.id}/clinical-note`, { token: await tokenOf('clinic1Admin') })).status).toBe(403);

    const notAttended = await http('POST', `/api/v1/appointments/${pending.id}/clinical-note`, {
      token: await tokenOf('clinic1Professional1'),
      body: { content: 'too early' },
    });
    expect(notAttended.status).toBe(422);
    expect(notAttended.body).toMatchObject({ code: 'CLINICAL_NOTE_REQUIRES_ATTENDED' });
  });

  it('exposes the audit log to the clinic admin only, with filters and pagination (RF19)', async () => {
    const admin = await tokenOf('clinic1Admin');
    const all = await http<{ data: { action: string; outcome: string; actorRole: string; resourceType: string }[] }>(
      'GET',
      `/api/v1/audit-log?patientId=${patientId}&resourceType=clinical_note&limit=100`,
      { token: admin },
    );
    expect(all.status).toBe(200);
    const summary = all.body.data.map((entry) => `${entry.action}:${entry.outcome}:${entry.actorRole}`).sort();
    // Rejected writes (duplicate note, note on a non-attended appointment) roll back and leave no row.
    expect(summary).toEqual([
      'create:denied:health_professional',
      'create:denied:receptionist',
      'create:success:health_professional',
      'read:denied:clinic_admin',
      'read:success:health_professional',
    ]);
    const page = await http<{ data: unknown[]; page: { nextCursor: string | null } }>('GET', `/api/v1/audit-log?patientId=${patientId}&limit=2`, {
      token: admin,
    });
    expect(page.body.data).toHaveLength(2);
    expect(page.body.page.nextCursor).not.toBeNull();
    expect((await http('GET', '/api/v1/audit-log', { token: await tokenOf('clinic1Receptionist') })).status).toBe(403);
  });

  it('keeps the audit log append-only even for the runtime roles (I6)', async () => {
    const attempt = withTransaction(
      runtime,
      { tenantId: CLINIC_1, actorSubject: null, dbRole: 'sch_clinic_admin', isolation: 'READ COMMITTED' },
      (client) => client.query("UPDATE audit_log SET action = 'read' WHERE patient_id = $1", [patientId]),
    );
    await expect(attempt).rejects.toMatchObject({ code: '42501' });
    await expect(owner.query('DELETE FROM scheduling.audit_log WHERE patient_id = $1', [patientId])).rejects.toMatchObject({ code: '42501' });
  });

  it('stores patient-contact audit events coming from user-management', async () => {
    const contactPatient = randomUUID();
    await userEvents.event(
      'user.patient.contact-accessed',
      userEvents.envelope({
        messageType: 'PatientContactAccessed',
        tenantId: CLINIC_1,
        actor: { subject: '30000000-0000-4000-8000-000000010002', roles: ['receptionist'] },
        payload: {
          patientId: contactPatient,
          action: 'read',
          outcome: 'success',
          actorSubject: '30000000-0000-4000-8000-000000010002',
          actorRole: 'receptionist',
          accessedAt: new Date().toISOString(),
        },
      }),
    );
    const admin = await tokenOf('clinic1Admin');
    await expect
      .poll(
        async () =>
          (await http<{ data: { resourceType: string; sourceService: string }[] }>('GET', `/api/v1/audit-log?patientId=${contactPatient}`, { token: admin }))
            .body.data,
        { timeout: 15_000, interval: 300 },
      )
      .toEqual([expect.objectContaining({ resourceType: 'patient_contact', sourceService: 'user-management' })]);
  });
});

describe('RF16 history, RF20 agenda and RF21 counts', () => {
  it('returns the patient history newest first and nothing for unknown patients', async () => {
    const token = await tokenOf('clinic1Receptionist');
    const history = await http<{ data: { appointmentId: string }[] }>('GET', `/api/v1/patients/${patientId}/appointments`, { token });
    expect(history.status).toBe(200);
    expect(history.body.data.map((item) => item.appointmentId).sort()).toEqual([attended.id, pending.id].sort());
    const unknown = await http<{ data: unknown[] }>('GET', `/api/v1/patients/${randomUUID()}/appointments`, { token });
    expect(unknown.body.data).toEqual([]);
  });

  it('forces professionals to their own agenda and gives reception the clinic-wide day', async () => {
    const own = await http<{ data: { items: { appointmentId: string; professionalDisplayName: string; patientId: string }[] } }>(
      'GET',
      `/api/v1/agenda?date=${attended.date}`,
      { token: await tokenOf('clinic1Professional1') },
    );
    expect(own.status).toBe(200);
    expect(own.body.data.items.map((item) => item.appointmentId)).toContain(attended.id);
    expect(own.body.data.items[0]).not.toHaveProperty('patientName');
    const other = await http('GET', `/api/v1/agenda?date=${attended.date}&professionalId=${PROFESSIONAL_2}`, {
      token: await tokenOf('clinic1Professional1'),
    });
    expect(other.status).toBe(403);
    const clinic = await http<{ data: { items: { professionalDisplayName: string }[] } }>('GET', `/api/v1/agenda?date=${attended.date}`, {
      token: await tokenOf('clinic1Receptionist'),
    });
    expect(clinic.body.data.items.length).toBeGreaterThanOrEqual(1);
  });

  it('counts appointments by status for a local date range', async () => {
    const response = await http<{ data: { counts: Record<string, number>; total: number } }>(
      'GET',
      `/api/v1/reports/appointment-status-counts?from=${attended.date}&to=${attended.date}&professionalId=${PROFESSIONAL_1}`,
      { token: await tokenOf('clinic1Admin') },
    );
    expect(response.status).toBe(200);
    expect(response.body.data.counts['attended']).toBeGreaterThanOrEqual(1);
    expect(response.body.data.total).toBeGreaterThanOrEqual(1);
    const tooLarge = await http('GET', `/api/v1/reports/appointment-status-counts?from=2024-01-01&to=2026-01-01`, { token: await tokenOf('clinic1Admin') });
    expect(tooLarge.status).toBe(422);
  });
});
