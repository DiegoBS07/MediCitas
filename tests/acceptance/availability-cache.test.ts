import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { EXCHANGES, type Envelope } from '@medicitas/messaging';
import { MessageTap, ServiceProbe } from '../support/services.js';
import { api, availability, book, eventually, expectStatus, localDate, type Appointment, type Availability, type ApiResult } from './support/api.js';
import { activeAppointments } from './support/evidence.js';
import { createPatient, createProfessional, tokenOf, type TestProfessional } from './support/fixture.js';
import { containerHealth, startContainers, stopContainers } from './support/stack.js';

/**
 * Acceptance criterion 5 ("la caché no miente") and invariants I7/I8 against the containers: Redis
 * serves RF7, PostgreSQL stays the source of truth. The key embeds a monotonic availability version
 * that every write bumps in its own transaction (ADR-0008), so a booking makes every previous copy
 * unreachable before the HTTP response is sent — no TTL wait. Also: miss/hit, cancel/reschedule,
 * blocks, catalog changes, duplicated and out-of-order invalidation events, and Redis outage.
 */
const fixture = inject('acceptance');
const DATE = localDate(fixture.timezone, 5);

let professional: TestProfessional;
let token: string;

const query = (date = DATE): Promise<ApiResult<Availability>> => availability(token, professional.professionalId, fixture.serviceId, date);
const starts = (result: ApiResult<Availability>): readonly string[] => result.body.data.slots.map((slot) => slot.startAt);

/** I8: no slot the API serves overlaps an active appointment stored in PostgreSQL. */
async function assertNoContradiction(result: ApiResult<Availability>): Promise<void> {
  const active = await activeAppointments(fixture.tenantId, professional.professionalId);
  for (const slot of result.body.data.slots) {
    const [start, end] = [new Date(slot.startAt).getTime(), new Date(slot.endAt).getTime()];
    const clash = active.find((row) => row.starts_at.getTime() < end && row.ends_at.getTime() > start);
    expect(clash, `served slot ${slot.startAt} overlaps active appointment ${clash?.id ?? ''}`).toBeUndefined();
  }
}

beforeAll(async () => {
  token = await tokenOf(fixture.receptionists[0]);
  professional = await createProfessional(fixture, { name: 'Dra. Caché' });
});

describe('RF7 cache: miss, hit and immediate invalidation (I7, I8)', () => {
  it('serves a MISS from PostgreSQL, then the same answer as a HIT from Redis', async () => {
    const first = expectStatus(await query(), 200);
    expect(first.headers.get('x-cache')).toBe('MISS');
    const second = expectStatus(await query(), 200);
    expect(second.headers.get('x-cache')).toBe('HIT');
    expect(second.body.data).toEqual(first.body.data);
  });

  it('criterion 5: query, book one of the returned slots, query again → the slot is already taken (no TTL wait)', async () => {
    const before = expectStatus(await query(), 200);
    expect(before.headers.get('x-cache')).toBe('HIT'); // a cached copy exists before the booking
    const startAt = String(starts(before)[2]);
    const patientId = await createPatient(token, 'Cache');
    expectStatus(await book(token, { patientId, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt }), 201);
    const after = expectStatus(await query(), 200);
    expect(starts(after)).not.toContain(startAt);
    expect(after.body.data.version).not.toBe(before.body.data.version);
    expect(after.headers.get('x-cache')).toBe('MISS'); // the old copy is unreachable under the new version
    const cachedAgain = expectStatus(await query(), 200);
    expect(cachedAgain.headers.get('x-cache')).toBe('HIT');
    expect(starts(cachedAgain)).not.toContain(startAt);
    await assertNoContradiction(cachedAgain);
  });

  it('cancel and reschedule free the slot immediately and visibly (I7)', async () => {
    const warm = expectStatus(await query(), 200);
    const patientId = await createPatient(token, 'Cache');
    const booked = expectStatus(await book(token, { patientId, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: String(starts(warm)[5]) }), 201)
      .body.data;
    await query(); // cache the post-booking view
    expectStatus(await api('POST', `/api/v1/appointments/${booked.appointmentId}/cancel`, { token, body: { reason: 'cache test' } }), 200);
    expect(starts(expectStatus(await query(), 200))).toContain(booked.startAt);

    const rebooked = expectStatus(await book(token, { patientId, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: booked.startAt }), 201).body.data;
    const view = expectStatus(await query(), 200);
    const target = String(starts(view).at(-1));
    const moved = expectStatus(
      await api<{ data: { current: Appointment } }>('POST', `/api/v1/appointments/${rebooked.appointmentId}/reschedule`, { token, body: { startAt: target } }),
      200,
    );
    const afterMove = expectStatus(await query(), 200);
    expect(starts(afterMove)).toContain(rebooked.startAt);
    expect(starts(afterMove)).not.toContain(moved.body.data.current.startAt);
    await assertNoContradiction(afterMove);
  });

  it('a calendar block and a catalog duration change are visible at once', async () => {
    const admin = await tokenOf(fixture.admin);
    await query();
    const block = expectStatus(
      await api<{ data: { blockId: string } }>('POST', `/api/v1/professionals/${professional.professionalId}/calendar-blocks`, {
        token: admin,
        body: { startAt: `${DATE}T13:00:00-06:00`, endAt: `${DATE}T17:00:00-06:00`, reason: 'leave' },
      }),
      201,
    );
    const blocked = expectStatus(await query(), 200);
    expect(blocked.body.data.slots.some((slot) => slot.localStartTime >= '13:00')).toBe(false);
    expectStatus(await api('DELETE', `/api/v1/professionals/${professional.professionalId}/calendar-blocks/${block.body.data.blockId}`, { token: admin }), 204);
    expect(expectStatus(await query(), 200).body.data.slots.some((slot) => slot.localStartTime >= '13:00')).toBe(true);

    // Catalog → scheduler replica (event-fed): a dedicated service so other tests keep their 30-minute service.
    const service = expectStatus(
      await api<{ data: { serviceId: string } }>('POST', '/api/v1/services', {
        token: admin,
        body: { name: `Control ${randomUUID().slice(0, 6)}`, specialtyId: fixture.specialtyId, durationMinutes: 30 },
      }),
      201,
    ).body.data.serviceId;
    expectStatus(await api('PUT', `/api/v1/professionals/${professional.professionalId}/services`, { token: admin, body: { serviceIds: [fixture.serviceId, service] } }), 200);
    const durationOf = async (): Promise<number | undefined> => {
      const result = await availability(token, professional.professionalId, service, DATE);
      return result.status === 200 ? result.body.data.durationMinutes : undefined;
    };
    expect(await eventually(durationOf, 20_000, 250, 'service replicated')).toBe(30);
    expectStatus(await api('PATCH', `/api/v1/services/${service}`, { token: admin, body: { durationMinutes: 60 } }), 200);
    await eventually(async () => ((await durationOf()) === 60 ? true : undefined), 20_000, 250, 'duration change visible');
    const sixty = expectStatus(await availability(token, professional.professionalId, service, DATE), 200);
    expect(sixty.body.data.slots.map((slot) => slot.localStartTime)).not.toContain('11:30'); // 11:30 + 60 min exceeds the 12:00 block
  });
});

describe('duplicated and out-of-order invalidation events never resurrect a stale view', () => {
  let tap: MessageTap;
  let scheduler: ServiceProbe;
  beforeAll(async () => {
    tap = await MessageTap.open([{ exchange: EXCHANGES.events, routingKey: 'scheduler.availability.changed' }]);
    scheduler = new ServiceProbe('scheduler-management');
    await scheduler.ready();
  });
  afterAll(async () => {
    await tap.close();
    await scheduler.close();
  });

  it('replays an AvailabilityChanged event twice (same messageId) and an older one after a newer booking', async () => {
    const date = localDate(fixture.timezone, 6);
    const patients = await Promise.all([createPatient(token, 'Evento'), createPatient(token, 'Evento')]);
    const view = expectStatus(await query(date), 200);
    // 30-minute slots on a 15-minute grid: index 0 (08:00) and 4 (09:00) do not overlap.
    const [firstSlot, secondSlot] = [String(starts(view)[0]), String(starts(view)[4])];
    expectStatus(await book(token, { patientId: String(patients[0]), professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: firstSlot }), 201);
    const older = await tap.waitFor((message: Envelope) => message.tenantId === fixture.tenantId && message.payload['professionalId'] === professional.professionalId, 15_000);
    expectStatus(await book(token, { patientId: String(patients[1]), professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: secondSlot }), 201);
    await query(date); // cache the newest view

    await scheduler.event('scheduler.availability.changed', older); // exact duplicate (inbox de-duplicates)
    await scheduler.event('scheduler.availability.changed', older);
    await scheduler.event('scheduler.availability.changed', { ...older, messageId: randomUUID(), occurredAt: new Date().toISOString() }); // stale content, new id
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = expectStatus(await query(date), 200);
      expect(starts(result)).not.toContain(firstSlot);
      expect(starts(result)).not.toContain(secondSlot);
      await assertNoContradiction(result);
    }
  });
});

describe('Redis outage: degrade to PostgreSQL, never fake a hit', () => {
  it('answers X-Cache: BYPASS with correct data while Redis is down, and caches again once it is back', async () => {
    const date = localDate(fixture.timezone, 7);
    await query(date);
    await stopContainers(['redis']);
    try {
      const down = expectStatus(await query(date), 200);
      expect(down.headers.get('x-cache')).toBe('BYPASS');
      const patientId = await createPatient(token, 'Redis');
      const startAt = String(starts(down)[0]);
      expectStatus(await book(token, { patientId, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt }), 201);
      const afterBooking = expectStatus(await query(date), 200);
      expect(afterBooking.headers.get('x-cache')).toBe('BYPASS');
      expect(starts(afterBooking)).not.toContain(startAt);
      await assertNoContradiction(afterBooking);
    } finally {
      await startContainers(['redis']);
    }
    expect(await containerHealth('redis')).toBe('healthy');
    const recovered = await eventually(async () => {
      const result = await query(date);
      return result.headers.get('x-cache') === 'BYPASS' ? undefined : result;
    }, 20_000, 500, 'scheduler reconnected to Redis');
    expect(['MISS', 'HIT']).toContain(recovered.headers.get('x-cache'));
    expect(expectStatus(await query(date), 200).headers.get('x-cache')).toBe('HIT');
  });
});
