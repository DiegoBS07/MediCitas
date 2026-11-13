import { beforeAll, describe, expect, inject, it } from 'vitest';
import { api, availability, book, codeOf, expectStatus, localDate, type ApiResult, type Appointment } from '../acceptance/support/api.js';
import { activeAppointments, patientOverlaps, professionalOverlaps } from '../acceptance/support/evidence.js';
import { createPatient, createProfessional, tokenOf, type TestProfessional } from '../acceptance/support/fixture.js';

/**
 * Acceptance criterion 6 ("la carrera tiene una sola ganadora"), against the running containers:
 * the full RF9 saga (gateway → appointment-orchestrator → RabbitMQ → user-management, catalog,
 * scheduler) with the scheduler as the authority of the time constraint (exclusion constraint on
 * tstzrange, READ COMMITTED + retry on serialization/deadlock, ADR-0007).
 *
 * The professional works ONE 30-minute slot a day (09:00–09:30), so every day offers exactly one —
 * the last — slot. Two distinct receptionists (two real Keycloak identities) race for it, round after
 * round on different days; then ten concurrent requests race for one slot. Each round asserts exactly
 * one 201, SLOT_TAKEN for every loser, no slot left, and the database evidence (one active row, no I1
 * overlap).
 */
const fixture = inject('acceptance');
const ROUNDS = 5;

/** Error code of the (single) 409 answer of a race. */
const conflictCode = (results: readonly ApiResult<unknown>[]): string | undefined => {
  const loser = results.find((result) => result.status === 409);
  return loser === undefined ? undefined : codeOf(loser);
};

let professional: TestProfessional;
let tokens: [string, string];

const onlySlot = async (date: string): Promise<string> => {
  const result = expectStatus(await availability(tokens[0], professional.professionalId, fixture.serviceId, date), 200, 'RF7');
  expect(result.body.data.slots).toHaveLength(1);
  return String(result.body.data.slots[0]?.startAt);
};

beforeAll(async () => {
  tokens = [await tokenOf(fixture.receptionists[0]), await tokenOf(fixture.receptionists[1])];
  professional = await createProfessional(fixture, {
    name: 'Dr. Último Espacio',
    blocks: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '09:30' })),
  });
});

describe('two receptionists race for the last slot (RF9, I1)', () => {
  for (let round = 1; round <= ROUNDS; round += 1) {
    it(`round ${round}: exactly one booking is granted, the other gets 409 SLOT_TAKEN`, async () => {
      const date = localDate(fixture.timezone, 10 + round);
      const startAt = await onlySlot(date);
      const patients = await Promise.all([createPatient(tokens[0], 'Carrera'), createPatient(tokens[1], 'Carrera')]);
      const results = await Promise.all(
        tokens.map((token, index) => book(token, { patientId: String(patients[index]), professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt })),
      );
      const statuses = results.map((result) => result.status).sort();
      expect(statuses).toEqual([201, 409]);
      expect(conflictCode(results)).toBe('SLOT_TAKEN');
      const winner = results.find((result) => result.status === 201)?.body.data as Appointment;
      expect(winner.startAt).toBe(startAt);

      expect(expectStatus(await availability(tokens[1], professional.professionalId, fixture.serviceId, date), 200).body.data.slots).toEqual([]);
      const rows = (await activeAppointments(fixture.tenantId, professional.professionalId)).filter((row) => row.starts_at.toISOString() === startAt);
      expect(rows).toEqual([expect.objectContaining({ id: winner.appointmentId, status: 'booked' })]);
    });
  }

  it('ten concurrent requests for one slot: one winner, nine SLOT_TAKEN, no duplicate', async () => {
    const date = localDate(fixture.timezone, 30);
    const startAt = await onlySlot(date);
    const patients = await Promise.all(Array.from({ length: 10 }, (_, index) => createPatient(tokens[index % 2] as string, 'Estampida')));
    const results = await Promise.all(
      patients.map((patientId, index) => book(tokens[index % 2] as string, { patientId, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt })),
    );
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    const losers = results.filter((result) => result.status !== 201);
    expect(losers.map((result) => [result.status, codeOf(result)])).toEqual(losers.map(() => [409, 'SLOT_TAKEN']));
    expect((await activeAppointments(fixture.tenantId, professional.professionalId)).filter((row) => row.starts_at.toISOString() === startAt)).toHaveLength(1);
  });

  it('never violates I1 across all rounds (database evidence)', async () => {
    expect(await professionalOverlaps(fixture.tenantId, professional.professionalId)).toBe(0);
    expect((await activeAppointments(fixture.tenantId, professional.professionalId)).length).toBe(ROUNDS + 1);
  });
});

describe('other races', () => {
  it('one patient booked at the same time with two professionals: one wins, the other gets 409 PATIENT_OVERLAP (I2)', async () => {
    const second = await createProfessional(fixture, {
      name: 'Dra. Paralela',
      blocks: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '09:30' })),
    });
    const date = localDate(fixture.timezone, 31);
    const startAt = await onlySlot(date);
    const patientId = await createPatient(tokens[0], 'Duplicada');
    const results = await Promise.all([
      book(tokens[0], { patientId, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt }),
      book(tokens[1], { patientId, professionalId: second.professionalId, serviceId: fixture.serviceId, startAt }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(conflictCode(results)).toBe('PATIENT_OVERLAP');
    expect(await patientOverlaps(fixture.tenantId, patientId)).toBe(0);
  });

  it('two reschedules into the same free slot: one succeeds atomically, the other keeps its original booking (RF10)', async () => {
    const [dateA, dateB, target] = [localDate(fixture.timezone, 32), localDate(fixture.timezone, 33), localDate(fixture.timezone, 34)];
    const [patientA, patientB] = await Promise.all([createPatient(tokens[0], 'Reprograma'), createPatient(tokens[1], 'Reprograma')]);
    const a = expectStatus(await book(tokens[0], { patientId: patientA, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: await onlySlot(dateA) }), 201).body.data;
    const b = expectStatus(await book(tokens[1], { patientId: patientB, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: await onlySlot(dateB) }), 201).body.data;
    const startAt = await onlySlot(target);
    const results = await Promise.all([
      api<{ data: { current: Appointment } }>('POST', `/api/v1/appointments/${a.appointmentId}/reschedule`, { token: tokens[0], body: { startAt } }),
      api<{ data: { current: Appointment } }>('POST', `/api/v1/appointments/${b.appointmentId}/reschedule`, { token: tokens[1], body: { startAt } }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const loserIndex = results.findIndex((result) => result.status === 409);
    expect(conflictCode(results)).toBe('SLOT_TAKEN');
    const loser = [a, b][loserIndex] as Appointment;
    const untouched = expectStatus(await api<{ data: Appointment }>('GET', `/api/v1/appointments/${loser.appointmentId}`, { token: tokens[0] }), 200).body.data;
    expect([untouched.status, untouched.startAt]).toEqual(['booked', loser.startAt]);
    expect(await professionalOverlaps(fixture.tenantId, professional.professionalId)).toBe(0);
  });
});
