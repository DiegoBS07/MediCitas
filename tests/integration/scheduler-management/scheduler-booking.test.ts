import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCacheConnection, type RedisConnection } from '@medicitas/cache';
import { EXCHANGES, type Envelope } from '@medicitas/messaging';
import { startScheduler, type SchedulerService } from '../../../application-plane/scheduler-management/src/service.js';
import { CLINIC_1, ownerPool } from '../../support/database.js';
import { silentLogger } from '../../support/broker.js';
import { MessageTap, ServiceProbe, httpClient } from '../../support/services.js';
import { crInstant, localDate, publishTestCatalog, schedulerConfig, waitForReplica, type TestAgenda } from '../../support/scheduler.js';
import { tokenOf } from '../../support/tokens.js';

const RECEPTIONIST_1 = { subject: '30000000-0000-4000-8000-000000010002', roles: ['receptionist' as const] };
const TZ = 'America/Costa_Rica';
const runId = randomUUID().slice(0, 6);
const owner = ownerPool('sch', 'medicitas_scheduler');
const day = localDate(TZ, 3);
// Random patients: the scheduler stores patient ids only (no PII), and fresh ids never collide with demo bookings (I2).
const patients = Array.from({ length: 6 }, () => randomUUID());

let scheduler: SchedulerService;
let http: ReturnType<typeof httpClient>;
let catalog: ServiceProbe;
let booking: ServiceProbe;
let replies: MessageTap;
let events: MessageTap;
let agenda: TestAgenda;
let admin: string;
let receptionist: string;
let redis: RedisConnection;

interface Slot {
  readonly startAt: string;
}
interface AvailabilityBody {
  readonly data: { readonly slots: readonly Slot[]; readonly version: string; readonly durationMinutes: number };
}

beforeAll(async () => {
  scheduler = await startScheduler(schedulerConfig());
  http = httpClient(scheduler.port);
  catalog = new ServiceProbe('catalog-service-management');
  booking = new ServiceProbe('appointment-orchestrator');
  await Promise.all([catalog.ready(), booking.ready()]);
  replies = await MessageTap.open([{ exchange: EXCHANGES.replies, routingKey: 'appointment-orchestrator' }]);
  events = await MessageTap.open([{ exchange: EXCHANGES.events, routingKey: 'scheduler.#' }]);
  agenda = await publishTestCatalog(catalog, CLINIC_1, runId);
  await waitForReplica(owner, agenda.professionalId, agenda.serviceId);
  await waitForReplica(owner, agenda.secondProfessionalId, agenda.serviceId);
  [admin, receptionist] = await Promise.all([tokenOf('clinic1Admin'), tokenOf('clinic1Receptionist')]);
  const everyDay = (start: string, end: string) => Array.from({ length: 7 }, (_, index) => ({ dayOfWeek: index + 1, startTime: start, endTime: end }));
  for (const professionalId of [agenda.professionalId, agenda.secondProfessionalId]) {
    const response = await http('PUT', `/api/v1/professionals/${professionalId}/weekly-schedule`, {
      token: admin,
      body: { blocks: everyDay('06:00', '22:00') },
    });
    expect(response.status).toBe(200);
  }
  redis = createCacheConnection(schedulerConfig().redis as NonNullable<ReturnType<typeof schedulerConfig>['redis']>, silentLogger);
  await redis.connect();
}, 60_000);

afterAll(async () => {
  await redis.quit();
  await owner.query(`DELETE FROM scheduling.tenants t WHERE slug LIKE 'it-%'
                     AND NOT EXISTS (SELECT 1 FROM scheduling.catalog_professionals p WHERE p.tenant_id = t.id)
                     AND NOT EXISTS (SELECT 1 FROM scheduling.catalog_services s WHERE s.tenant_id = t.id)
                     AND NOT EXISTS (SELECT 1 FROM scheduling.audit_log l WHERE l.tenant_id = t.id)`);
  await owner.end();
  for (const closable of [replies, events, catalog, booking]) await closable.close();
  await scheduler.stop();
});

const availability = (professionalId = agenda.professionalId, date = day) =>
  http<AvailabilityBody>('GET', `/api/v1/availability?professionalId=${professionalId}&serviceId=${agenda.serviceId}&date=${date}`, {
    token: receptionist,
  });

function hold(startAt: string, overrides: { readonly patientId?: string; readonly professionalId?: string; readonly appointmentId?: string } = {}): Envelope {
  return booking.envelope({
    messageType: 'HoldSlotCommand',
    tenantId: CLINIC_1,
    actor: RECEPTIONIST_1,
    sagaId: randomUUID(),
    stepId: 'slot',
    replyTo: 'appointment-orchestrator',
    payload: {
      appointmentId: overrides.appointmentId ?? randomUUID(),
      patientId: overrides.patientId ?? (patients[0] as string),
      professionalId: overrides.professionalId ?? agenda.professionalId,
      serviceId: agenda.serviceId,
      startAt,
    },
  });
}

async function send(routingKey: string, command: Envelope): Promise<Envelope> {
  await booking.command(routingKey, command);
  return replies.waitFor((message) => message.commandId === command.messageId);
}

async function book(startAt: string, patientId: string, professionalId = agenda.professionalId): Promise<string> {
  const command = hold(startAt, { patientId, professionalId });
  const held = await send('scheduler-management.slot.hold', command);
  expect(held.payload).toMatchObject({ outcome: 'succeeded' });
  const appointmentId = String(command.payload['appointmentId']);
  const confirm = booking.envelope({
    messageType: 'ConfirmAppointmentCommand',
    tenantId: CLINIC_1,
    actor: RECEPTIONIST_1,
    sagaId: command.sagaId,
    replyTo: 'appointment-orchestrator',
    payload: { appointmentId },
  });
  expect((await send('scheduler-management.slot.confirm', confirm)).payload).toMatchObject({ outcome: 'succeeded', result: { status: 'booked' } });
  return appointmentId;
}

const hasSlot = (result: { readonly body: AvailabilityBody }, startAt: string): boolean =>
  result.body.data.slots.some((slot) => Date.parse(slot.startAt) === Date.parse(startAt));

describe('RF5 weekly schedule', () => {
  it('rejects overlapping blocks and enforces ownership', async () => {
    const overlap = await http('PUT', `/api/v1/professionals/${agenda.professionalId}/weekly-schedule`, {
      token: admin,
      body: { blocks: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }, { dayOfWeek: 1, startTime: '11:00', endTime: '13:00' }] },
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body).toMatchObject({ code: 'SCHEDULE_OVERLAP' });
    const notOwn = await http('PUT', `/api/v1/professionals/${agenda.professionalId}/weekly-schedule`, {
      token: await tokenOf('clinic1Professional1'),
      body: { blocks: [] },
    });
    expect(notOwn.status).toBe(403);
    expect((await http('PUT', `/api/v1/professionals/${agenda.professionalId}/weekly-schedule`, { token: receptionist, body: { blocks: [] } })).status).toBe(403);
    const read = await http<{ data: { blocks: unknown[]; timezone: string } }>('GET', `/api/v1/professionals/${agenda.professionalId}/weekly-schedule`, {
      token: receptionist,
    });
    expect(read.body.data.blocks).toHaveLength(7);
    expect(read.body.data.timezone).toBe(TZ);
  });
});

describe('RF7 availability and the version-keyed cache (I7, I8)', () => {
  it('misses, then hits, and never serves a slot taken after the entry was cached', async () => {
    const first = await availability();
    expect(first.status).toBe(200);
    expect(first.headers.get('x-cache')).toBe('MISS');
    expect(first.body.data.durationMinutes).toBe(30);
    const second = await availability();
    expect(second.headers.get('x-cache')).toBe('HIT');
    expect(second.body.data.slots).toEqual(first.body.data.slots);

    const startAt = crInstant(day, '09:00');
    expect(hasSlot(second, startAt)).toBe(true);
    const appointmentId = await book(startAt, patients[0] as string);
    const after = await availability();
    expect(after.headers.get('x-cache')).toBe('MISS');
    expect(hasSlot(after, startAt)).toBe(false);
    expect(hasSlot(after, crInstant(day, '08:45'))).toBe(false);
    expect(hasSlot(after, crInstant(day, '09:30'))).toBe(true);

    const created = await events.waitFor((message) => message.messageType === 'AppointmentCreated' && message.payload['appointmentId'] === appointmentId);
    expect(created.payload).toMatchObject({ status: 'booked', durationMinutes: 30 });
  });

  it('rejects a cached value whose identity does not match the request (tampering)', async () => {
    const current = await availability(agenda.secondProfessionalId);
    const version = current.body.data.version;
    const key = `availability:v1:tenant:${CLINIC_1}:professional:${agenda.secondProfessionalId}:service:${agenda.serviceId}:date:${day}:version:${version}`;
    const forged = { ...JSON.parse((await redis.get(key)) ?? '{}'), tenantId: '10000000-0000-4000-8000-000000000002', slots: [] };
    await redis.set(key, JSON.stringify(forged), { expiration: { type: 'EX', value: 60 } });
    const read = await availability(agenda.secondProfessionalId);
    expect(read.headers.get('x-cache')).toBe('MISS');
    expect(read.body.data.slots.length).toBeGreaterThan(0);
  });

  it('degrades to PostgreSQL (X-Cache: BYPASS) when Redis is unreachable', async () => {
    const degraded = await startScheduler(
      schedulerConfig({ redis: { host: '127.0.0.1', port: 1, username: 'scheduler', password: 'unused-password' } }),
    );
    try {
      const response = await httpClient(degraded.port)<AvailabilityBody>(
        'GET',
        `/api/v1/availability?professionalId=${agenda.professionalId}&serviceId=${agenda.serviceId}&date=${day}`,
        { token: receptionist },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('x-cache')).toBe('BYPASS');
      expect(hasSlot(response, crInstant(day, '09:00'))).toBe(false);
    } finally {
      await degraded.stop();
    }
  });

  it('validates input before touching the cache', async () => {
    const past = await availability(agenda.professionalId, localDate(TZ, -1));
    expect(past.status).toBe(400);
    const foreign = await http('GET', `/api/v1/availability?professionalId=42000000-0000-4000-8000-000000020001&serviceId=${agenda.serviceId}&date=${day}`, {
      token: receptionist,
    });
    expect(foreign.status).toBe(404);
  });
});

describe('RF9 slot authority: holds, the race for the last slot, release and expiry', () => {
  it('produces exactly one winner when two holds race for the same slot', async () => {
    const startAt = crInstant(day, '10:00');
    const contenders = [hold(startAt, { patientId: patients[1] as string }), hold(startAt, { patientId: patients[2] as string })];
    const results = await Promise.all(contenders.map((command) => send('scheduler-management.slot.hold', command)));
    const outcomes = results.map((reply) => reply.payload['outcome']).sort();
    expect(outcomes).toEqual(['rejected', 'succeeded']);
    const loser = results.find((reply) => reply.payload['outcome'] === 'rejected') as Envelope;
    expect(loser.payload).toMatchObject({ error: { code: 'SLOT_TAKEN' } });
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM scheduling.appointments WHERE professional_id = $1 AND starts_at = $2 AND status IN ('held','booked')`,
      [agenda.professionalId, startAt],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  it('rejects a patient overlap (I2), misaligned, past and out-of-hours starts', async () => {
    const startAt = crInstant(day, '11:00');
    expect((await send('scheduler-management.slot.hold', hold(startAt, { patientId: patients[3] as string }))).payload).toMatchObject({ outcome: 'succeeded' });
    const patientClash = hold(crInstant(day, '11:15'), { patientId: patients[3] as string, professionalId: agenda.secondProfessionalId });
    expect((await send('scheduler-management.slot.hold', patientClash)).payload).toMatchObject({ error: { code: 'PATIENT_OVERLAP' } });
    expect((await send('scheduler-management.slot.hold', hold(crInstant(day, '12:05')))).payload).toMatchObject({ error: { code: 'SLOT_MISALIGNED' } });
    expect((await send('scheduler-management.slot.hold', hold(crInstant(localDate(TZ, -2), '09:00')))).payload).toMatchObject({
      error: { code: 'SLOT_IN_PAST' },
    });
    expect((await send('scheduler-management.slot.hold', hold(crInstant(day, '03:00')))).payload).toMatchObject({
      error: { code: 'OUTSIDE_WORKING_HOURS' },
    });
  });

  it('releases a hold (compensation) and expires forgotten holds, freeing the slot at once', async () => {
    const startAt = crInstant(day, '13:00');
    const held = hold(startAt, { patientId: patients[4] as string });
    await send('scheduler-management.slot.hold', held);
    expect(hasSlot(await availability(), startAt)).toBe(false);
    const release = booking.envelope({
      messageType: 'ReleaseSlotCommand',
      tenantId: CLINIC_1,
      actor: RECEPTIONIST_1,
      sagaId: held.sagaId,
      replyTo: 'appointment-orchestrator',
      payload: { appointmentId: held.payload['appointmentId'], reasonCode: 'SAGA_FAILED' },
    });
    expect((await send('scheduler-management.slot.release', release)).payload).toMatchObject({ result: { released: true } });
    expect(hasSlot(await availability(), startAt)).toBe(true);

    const forgotten = hold(crInstant(day, '14:00'), { patientId: patients[5] as string });
    await send('scheduler-management.slot.hold', forgotten);
    await owner.query(`UPDATE scheduling.appointments SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [
      forgotten.payload['appointmentId'],
    ]);
    expect(await scheduler.sweeper.sweep()).toBeGreaterThanOrEqual(1);
    expect(hasSlot(await availability(), crInstant(day, '14:00'))).toBe(true);
    const lateConfirm = booking.envelope({
      messageType: 'ConfirmAppointmentCommand',
      tenantId: CLINIC_1,
      actor: RECEPTIONIST_1,
      replyTo: 'appointment-orchestrator',
      payload: { appointmentId: forgotten.payload['appointmentId'] },
    });
    expect((await send('scheduler-management.slot.confirm', lateConfirm)).payload).toMatchObject({ error: { code: 'HOLD_EXPIRED' } });
  });
});

describe('RF10–RF13 appointment lifecycle and RF6 blocks', () => {
  it('reschedules atomically, cancels with immediate release and enforces the state machine', async () => {
    const original = await book(crInstant(day, '15:00'), patients[1] as string);
    const rescheduled = await http<{ data: { previous: { status: string }; current: { appointmentId: string; status: string; rescheduledFromId: string } } }>(
      'POST',
      `/api/v1/appointments/${original}/reschedule`,
      { token: receptionist, body: { startAt: crInstant(day, '15:15') } },
    );
    expect(rescheduled.status).toBe(200);
    expect(rescheduled.body.data.previous.status).toBe('rescheduled');
    expect(rescheduled.body.data.current).toMatchObject({ status: 'booked', rescheduledFromId: original });
    const current = rescheduled.body.data.current.appointmentId;
    const after = await availability();
    expect(hasSlot(after, crInstant(day, '15:00'))).toBe(false);
    expect(hasSlot(after, crInstant(day, '14:30'))).toBe(true);

    const again = await http('POST', `/api/v1/appointments/${original}/reschedule`, { token: receptionist, body: { startAt: crInstant(day, '16:00') } });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    const taken = await http('POST', `/api/v1/appointments/${current}/reschedule`, { token: receptionist, body: { startAt: crInstant(day, '09:00') } });
    expect(taken.body).toMatchObject({ code: 'SLOT_TAKEN' });
    const unchanged = await http<{ data: { status: string } }>('GET', `/api/v1/appointments/${current}`, { token: receptionist });
    expect(unchanged.body.data.status).toBe('booked');

    const early = await http('POST', `/api/v1/appointments/${current}/outcome`, { token: receptionist, body: { outcome: 'attended' } });
    expect(early.status).toBe(422);
    expect(early.body).toMatchObject({ code: 'OUTCOME_BEFORE_START' });

    const cancelled = await http<{ data: { status: string; cancellation: { cancelledBy: string } } }>(
      'POST',
      `/api/v1/appointments/${current}/cancel`,
      { token: receptionist, body: { reason: 'Patient request' }, headers: { 'Idempotency-Key': `it-cancel-${runId}-000001` } },
    );
    expect(cancelled.body.data).toMatchObject({ status: 'cancelled', cancellation: { cancelledBy: RECEPTIONIST_1.subject } });
    expect(hasSlot(await availability(), crInstant(day, '15:15'))).toBe(true);
    const replay = await http('POST', `/api/v1/appointments/${current}/cancel`, {
      token: receptionist,
      body: { reason: 'Patient request' },
      headers: { 'Idempotency-Key': `it-cancel-${runId}-000001` },
    });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    const twice = await http('POST', `/api/v1/appointments/${current}/cancel`, { token: receptionist, body: { reason: 'Again' } });
    expect(twice.body).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    expect((await http('POST', `/api/v1/appointments/${current}/cancel`, { token: await tokenOf('clinic1Professional1'), body: { reason: 'x' } })).status).toBe(403);
  });

  it('lists booked appointments inside a new calendar block as conflicts without cancelling them', async () => {
    const booked = await book(crInstant(day, '17:00'), patients[2] as string);
    const block = await http<{ data: { blockId: string; conflicts: { appointmentId: string }[] } }>(
      'POST',
      `/api/v1/professionals/${agenda.professionalId}/calendar-blocks`,
      { token: admin, body: { startAt: crInstant(day, '16:30'), endAt: crInstant(day, '18:00'), reason: 'leave' } },
    );
    expect(block.status).toBe(201);
    expect(block.body.data.conflicts.map((conflict) => conflict.appointmentId)).toEqual([booked]);
    expect(hasSlot(await availability(), crInstant(day, '17:30'))).toBe(false);
    const conflicts = await http<{ data: { appointment: { appointmentId: string }; reasons: string[] }[] }>(
      'GET',
      `/api/v1/schedule-conflicts?professionalId=${agenda.professionalId}&from=${day}&to=${day}`,
      { token: receptionist },
    );
    expect(conflicts.body.data).toContainEqual(expect.objectContaining({ appointment: expect.objectContaining({ appointmentId: booked }), reasons: ['CALENDAR_BLOCK'] }));
    const stillBooked = await http<{ data: { status: string } }>('GET', `/api/v1/appointments/${booked}`, { token: receptionist });
    expect(stillBooked.body.data.status).toBe('booked');

    const removed = await http('DELETE', `/api/v1/professionals/${agenda.professionalId}/calendar-blocks/${block.body.data.blockId}`, { token: admin });
    expect(removed.status).toBe(204);
    expect(hasSlot(await availability(), crInstant(day, '17:30'))).toBe(true);
    const tooLong = await http('POST', `/api/v1/professionals/${agenda.professionalId}/calendar-blocks`, {
      token: admin,
      body: { startAt: crInstant(day, '00:00'), endAt: crInstant(localDate(TZ, 100), '00:00'), reason: 'vacation' },
    });
    expect(tooLong.status).toBe(422);
  });

  it('answers 404 for appointments of another tenant and hides internal states', async () => {
    const foreign = await http('GET', `/api/v1/appointments/${randomUUID()}`, { token: await tokenOf('clinic2Receptionist') });
    expect(foreign.status).toBe(404);
  });
});
