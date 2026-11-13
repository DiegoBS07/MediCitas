import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { api, availability, book, codeOf, eventually, expectStatus, localDate, type Appointment } from './support/api.js';
import { insertPastAppointment as insertAppointment } from './support/clock.js';
import { createPatient, createProfessional, tokenOf, type TestProfessional } from './support/fixture.js';

/**
 * At least one test per invariant, here I1–I4 through the API AND at engine level
 * (a direct insert that bypasses every service must still be rejected by PostgreSQL). I5 is covered
 * by tenant-isolation.test.ts, I6 by audit.test.ts, I7/I8 by availability-cache.test.ts.
 */
const fixture = inject('acceptance');
const DATE = localDate(fixture.timezone, 8);
const at = (time: string, date = DATE): string => `${date}T${time}:00-06:00`;
const iso = (time: string, date = DATE): string => new Date(at(time, date)).toISOString();

let professional: TestProfessional;
let second: TestProfessional;
let token: string;
let patient: string;
let otherPatient: string;
let anchor: Appointment;

const attempt = (patientId: string, startAt: string, professionalId = professional.professionalId) =>
  book(token, { patientId, professionalId, serviceId: fixture.serviceId, startAt });

beforeAll(async () => {
  token = await tokenOf(fixture.receptionists[0]);
  [professional, second] = await Promise.all([createProfessional(fixture, { name: 'Dr. Invariant A' }), createProfessional(fixture, { name: 'Dr. Invariant B' })]);
  [patient, otherPatient] = await Promise.all([createPatient(token, 'Invariant'), createPatient(token, 'Invariant')]);
  anchor = expectStatus(await attempt(patient, at('09:00')), 201, 'anchor booking').body.data; // 09:00–09:30
});

describe('I1: a professional never has two overlapping active appointments', () => {
  it('rejects overlapping starts with 409 SLOT_TAKEN and accepts the adjacent slot (half-open interval)', async () => {
    for (const time of ['08:45', '09:00', '09:15']) {
      const result = await attempt(otherPatient, at(time));
      expect([time, result.status, codeOf(result)]).toEqual([time, 409, 'SLOT_TAKEN']);
    }
    const adjacent = expectStatus(await attempt(otherPatient, at('09:30')), 201);
    expect(adjacent.body.data.startAt).toBe(iso('09:30'));
  });

  it('is enforced by the engine: a direct overlapping insert violates the exclusion constraint', async () => {
    const insert = insertAppointment({
      tenantId: fixture.tenantId,
      professionalId: professional.professionalId,
      serviceId: fixture.serviceId,
      patientId: randomUUID(),
      bookedBy: fixture.receptionists[0].subject,
      daysAgo: -8,
      localTime: '09:15',
    });
    await expect(insert).rejects.toMatchObject({ code: '23P01' });
  });
});

describe('I2: a patient never has two overlapping active appointments in the clinic', () => {
  it('rejects the same patient with another professional at an overlapping time (409 PATIENT_OVERLAP)', async () => {
    const result = await attempt(patient, at('09:15'), second.professionalId);
    expect([result.status, codeOf(result)]).toEqual([409, 'PATIENT_OVERLAP']);
    expect((await attempt(patient, at('10:00'), second.professionalId)).status).toBe(201);
  });

  it('is enforced by the engine as well', async () => {
    const insert = insertAppointment({
      tenantId: fixture.tenantId,
      professionalId: second.professionalId,
      serviceId: fixture.serviceId,
      patientId: patient,
      bookedBy: fixture.receptionists[0].subject,
      daysAgo: -8,
      localTime: '09:00',
    });
    await expect(insert).rejects.toMatchObject({ code: '23P01' });
  });
});

describe('I3: every active appointment lies inside working hours and outside calendar blocks', () => {
  it('rejects starts outside the weekly blocks, misaligned, in the past or inside a calendar block (422)', async () => {
    const cases: readonly (readonly [string, string])[] = [
      [at('07:45'), 'OUTSIDE_WORKING_HOURS'],
      [at('11:45'), 'OUTSIDE_WORKING_HOURS'], // would end 12:15, past the 12:00 block end
      [at('12:15'), 'OUTSIDE_WORKING_HOURS'], // lunch gap of the split day
      [at('16:45'), 'OUTSIDE_WORKING_HOURS'],
      [at('10:05'), 'SLOT_MISALIGNED'],
      [at('09:00', localDate(fixture.timezone, -1)), 'SLOT_IN_PAST'],
    ];
    for (const [startAt, code] of cases) {
      const result = await attempt(otherPatient, startAt);
      expect([startAt, result.status, codeOf(result)]).toEqual([startAt, 422, code]);
    }
    const admin = await tokenOf(fixture.admin);
    expectStatus(
      await api('POST', `/api/v1/professionals/${professional.professionalId}/calendar-blocks`, {
        token: admin,
        body: { startAt: at('15:00'), endAt: at('17:00'), reason: 'vacation' },
      }),
      201,
    );
    const blocked = await attempt(otherPatient, at('15:30'));
    expect([blocked.status, codeOf(blocked)]).toEqual([422, 'SLOT_BLOCKED']);
    const moveIntoBlock = await api('POST', `/api/v1/appointments/${anchor.appointmentId}/reschedule`, { token, body: { startAt: at('16:00') } });
    expect([moveIntoBlock.status, codeOf(moveIntoBlock)]).toEqual([422, 'SLOT_BLOCKED']);
    expect(expectStatus(await api<{ data: Appointment }>('GET', `/api/v1/appointments/${anchor.appointmentId}`, { token }), 200).body.data).toMatchObject({
      status: 'booked',
      startAt: anchor.startAt,
    });
  });

  it('is enforced by the engine: a direct insert outside working hours is rejected', async () => {
    const insert = insertAppointment({
      tenantId: fixture.tenantId,
      professionalId: second.professionalId,
      serviceId: fixture.serviceId,
      patientId: randomUUID(),
      bookedBy: fixture.receptionists[0].subject,
      daysAgo: -8,
      localTime: '12:15',
    });
    await expect(insert).rejects.toThrow();
  });
});

describe('I4: the duration is defined by the service and no operation alters it on its own', () => {
  it('refuses a client-sent end or duration (400)', async () => {
    for (const extra of [{ endAt: at('11:00') }, { durationMinutes: 15 }]) {
      const result = await api('POST', '/api/v1/appointments', {
        token,
        idempotencyKey: true,
        body: { patient: { id: otherPatient }, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: at('10:30'), ...extra },
      });
      expect([result.status, codeOf(result)]).toEqual([400, 'VALIDATION_FAILED']);
    }
  });

  it('keeps the stored interval when the service duration changes later; a reschedule takes the duration from the service again', async () => {
    const admin = await tokenOf(fixture.admin);
    const serviceId = expectStatus(
      await api<{ data: { serviceId: string } }>('POST', '/api/v1/services', {
        token: admin,
        body: { name: `Duration ${randomUUID().slice(0, 6)}`, specialtyId: fixture.specialtyId, durationMinutes: 30 },
      }),
      201,
    ).body.data.serviceId;
    expectStatus(await api('PUT', `/api/v1/professionals/${second.professionalId}/services`, { token: admin, body: { serviceIds: [fixture.serviceId, serviceId] } }), 200);
    const date = localDate(fixture.timezone, 9);
    const slots = await eventually(async () => {
      const result = await availability(token, second.professionalId, serviceId, date);
      return result.status === 200 ? result.body.data.slots : undefined;
    }, 20_000, 250, 'service replicated');
    const booked = expectStatus(await book(token, { patientId: otherPatient, professionalId: second.professionalId, serviceId, startAt: String(slots[0]?.startAt) }), 201).body.data;
    expect(booked.durationMinutes).toBe(30);

    expectStatus(await api('PATCH', `/api/v1/services/${serviceId}`, { token: admin, body: { durationMinutes: 45 } }), 200);
    await eventually(async () => {
      const result = await availability(token, second.professionalId, serviceId, date);
      return result.status === 200 && result.body.data.durationMinutes === 45 ? true : undefined;
    }, 20_000, 250, 'new duration replicated');
    const stored = expectStatus(await api<{ data: Appointment }>('GET', `/api/v1/appointments/${booked.appointmentId}`, { token }), 200).body.data;
    expect([stored.durationMinutes, new Date(stored.endAt).getTime() - new Date(stored.startAt).getTime()]).toEqual([30, 30 * 60_000]);

    const moved = expectStatus(
      await api<{ data: { current: Appointment } }>('POST', `/api/v1/appointments/${booked.appointmentId}/reschedule`, { token, body: { startAt: at('14:00', date) } }),
      200,
    ).body.data.current;
    // The new appointment's duration comes from the service (never from the client or the old row);
    // the previous appointment keeps its stored 30-minute interval as history.
    expect(moved.durationMinutes).toBe(45);
    expect(new Date(moved.endAt).getTime() - new Date(moved.startAt).getTime()).toBe(45 * 60_000);
    const previous = expectStatus(await api<{ data: Appointment }>('GET', `/api/v1/appointments/${booked.appointmentId}`, { token }), 200).body.data;
    expect([previous.status, previous.durationMinutes]).toEqual(['rescheduled', 30]);
  });

  it('is enforced by the engine: a direct insert whose interval differs from the service duration is rejected', async () => {
    const insert = insertAppointment({
      tenantId: fixture.tenantId,
      professionalId: second.professionalId,
      serviceId: fixture.serviceId,
      patientId: randomUUID(),
      bookedBy: fixture.receptionists[0].subject,
      daysAgo: -8,
      localTime: '14:00',
      durationMinutes: 50,
    });
    await expect(insert).rejects.toThrow();
  });
});
