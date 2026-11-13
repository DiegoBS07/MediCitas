import { beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  availability,
  book,
  codeOf,
  expectStatus,
  isoWeekday,
  localDate,
  type ApiResult,
  type Appointment,
} from './support/api.js';
import { insertPastAppointment } from './support/clock.js';
import { DEFAULT_WEEK, createPatient, createProfessional, createStaff, passwordToken, seededToken, tokenOf, type TestProfessional } from './support/fixture.js';

/**
 * Acceptance criterion 2 ("el ciclo de la cita se cumple"): book, reschedule, cancel and record the
 * outcome through the gateway with the declared status codes, and reject every forbidden transition
 * (RF13). Also walks RF1–RF8, RF14–RF16 and RF20–RF21 on the run clinic, end to end over RabbitMQ.
 */
const fixture = inject('acceptance');
const DATE = localDate(fixture.timezone, 3);

let professional: TestProfessional;
let receptionist: string;
let admin: string;
let professionalToken: string;
let patientId: string;
let first: Appointment;
let current: Appointment;
let inlinePatientBooking: Appointment;

const slotsOf = async (date = DATE): Promise<readonly string[]> =>
  expectStatus(await availability(receptionist, professional.professionalId, fixture.serviceId, date), 200, 'RF7').body.data.slots.map((slot) => slot.startAt);

beforeAll(async () => {
  [receptionist, admin] = await Promise.all([tokenOf(fixture.receptionists[0]), tokenOf(fixture.admin)]);
  professional = await createProfessional(fixture, { name: 'Dra. Ciclo Completo' });
  professionalToken = await tokenOf(professional.member);
  patientId = await createPatient(receptionist, 'Ciclo');
});

describe('RF1–RF4: the run clinic was onboarded and configured through the API', () => {
  it('RF1: the clinic is active and its first admin is bound to it by the token', async () => {
    const tenant = expectStatus(await api<{ data: { status: string; timezone: string; slug: string } }>('GET', `/api/v1/tenants/${fixture.tenantId}`, { token: await seededToken('platformAdmin') }), 200);
    expect(tenant.body.data).toMatchObject({ status: 'active', timezone: fixture.timezone, slug: fixture.slug });
    const me = expectStatus(await api<{ data: { tenantId: string; roles: string[] } }>('GET', '/api/v1/me', { token: admin }), 200);
    expect(me.body.data).toMatchObject({ tenantId: fixture.tenantId, roles: ['clinic_admin'] });
  });

  it('RF3/RF4: the service and the professional association are readable by reception', async () => {
    const services = expectStatus(await api<{ data: { serviceId: string; durationMinutes: number }[] }>('GET', '/api/v1/services', { token: receptionist }), 200);
    expect(services.body.data).toContainEqual(expect.objectContaining({ serviceId: fixture.serviceId, durationMinutes: 30 }));
    const offered = expectStatus(await api<{ data: { serviceId: string }[] }>('GET', `/api/v1/professionals/${professional.professionalId}/services`, { token: receptionist }), 200);
    expect(offered.body.data.map((service) => service.serviceId)).toEqual([fixture.serviceId]);
  });

  it('RF5: the weekly schedule keeps several blocks per day (split day)', async () => {
    const schedule = expectStatus(
      await api<{ data: { blocks: { dayOfWeek: number; startTime: string; endTime: string }[] } }>('GET', `/api/v1/professionals/${professional.professionalId}/weekly-schedule`, {
        token: receptionist,
      }),
      200,
    );
    expect(schedule.body.data.blocks.filter((block) => block.dayOfWeek === isoWeekday(DATE))).toEqual([
      expect.objectContaining({ startTime: '08:00', endTime: '12:00' }),
      expect.objectContaining({ startTime: '13:00', endTime: '17:00' }),
    ]);
  });
});

describe('RF7/RF8 availability', () => {
  it('RF7 lists 30-minute slots on the 15-minute grid inside both blocks; RF8 finds the professional', async () => {
    const result = expectStatus(await availability(receptionist, professional.professionalId, fixture.serviceId, DATE), 200);
    expect(result.headers.get('x-cache')).toMatch(/^(HIT|MISS|BYPASS)$/);
    const local = result.body.data.slots.map((slot) => slot.localStartTime);
    expect(result.body.data.durationMinutes).toBe(30);
    expect(local[0]).toBe('08:00');
    expect(local).toContain('11:30'); // last start of the morning block (ends 12:00)
    expect(local).not.toContain('11:45');
    expect(local).toContain('13:00');
    expect(local.at(-1)).toBe('16:30');
    const search = expectStatus(
      await api<{ data: { professionals: { professionalId: string; days: { date: string }[] }[] } }>(
        'GET',
        `/api/v1/availability/search?serviceId=${fixture.serviceId}&from=${DATE}&to=${localDate(fixture.timezone, 5)}`,
        { token: receptionist },
      ),
      200,
    );
    expect(search.body.data.professionals.find((candidate) => candidate.professionalId === professional.professionalId)?.days.map((day) => day.date)).toContain(DATE);
  });
});

describe('RF9–RF13: book, reschedule, cancel, outcome and the state machine', () => {
  it('RF9 grants a booking (201 + Location), with the duration taken from the service (I4)', async () => {
    const [startAt] = await slotsOf();
    const booked = expectStatus(await book(receptionist, { patientId, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: String(startAt) }), 201, 'RF9');
    first = booked.body.data;
    expect(first).toMatchObject({ status: 'booked', durationMinutes: 30, patientId, professionalId: professional.professionalId });
    expect(new Date(first.endAt).getTime() - new Date(first.startAt).getTime()).toBe(30 * 60_000);
    expect(booked.headers.get('location')).toBe(`/api/v1/appointments/${first.appointmentId}`);
    expect(expectStatus(await api<{ data: Appointment }>('GET', `/api/v1/appointments/${first.appointmentId}`, { token: receptionist }), 200).body.data.status).toBe('booked');
    expect(await slotsOf()).not.toContain(first.startAt);
  });

  it('RF10 reschedules atomically: the old slot is freed and the new one taken in the same transaction', async () => {
    const target = (await slotsOf()).find((slot) => new Date(slot).getTime() >= new Date(first.startAt).getTime() + 2 * 3_600_000);
    const result = expectStatus(
      await api<{ data: { previous: Appointment; current: Appointment } }>('POST', `/api/v1/appointments/${first.appointmentId}/reschedule`, {
        token: receptionist,
        body: { startAt: target },
      }),
      200,
      'RF10',
    );
    expect(result.body.data.previous).toMatchObject({ appointmentId: first.appointmentId, status: 'rescheduled', rescheduledToId: result.body.data.current.appointmentId });
    expect(result.body.data.current).toMatchObject({ status: 'booked', rescheduledFromId: first.appointmentId, durationMinutes: 30 });
    current = result.body.data.current;
    const slots = await slotsOf();
    expect(slots).toContain(first.startAt); // I7: freed at once
    expect(slots).not.toContain(current.startAt);
  });

  it('RF13 rejects every transition out of a final state (rescheduled) with 409 INVALID_STATE_TRANSITION', async () => {
    const [free] = await slotsOf();
    const attempts: ApiResult<unknown>[] = await Promise.all([
      api('POST', `/api/v1/appointments/${first.appointmentId}/cancel`, { token: receptionist, body: { reason: 'too late' } }),
      api('POST', `/api/v1/appointments/${first.appointmentId}/reschedule`, { token: receptionist, body: { startAt: free } }),
      api('POST', `/api/v1/appointments/${first.appointmentId}/outcome`, { token: receptionist, body: { outcome: 'attended' } }),
    ]);
    for (const attempt of attempts) {
      expect(attempt.status).toBe(409);
      expect(codeOf(attempt)).toBe('INVALID_STATE_TRANSITION');
    }
  });

  it('RF12 refuses an outcome before the start time (422 OUTCOME_BEFORE_START)', async () => {
    const early = await api('POST', `/api/v1/appointments/${current.appointmentId}/outcome`, { token: professionalToken, body: { outcome: 'attended' } });
    expect([early.status, codeOf(early)]).toEqual([422, 'OUTCOME_BEFORE_START']);
  });

  it('RF11 cancels with reason and author, frees the slot, and a cancelled appointment cannot move again', async () => {
    const cancelled = expectStatus(
      await api<{ data: Appointment }>('POST', `/api/v1/appointments/${current.appointmentId}/cancel`, { token: receptionist, body: { reason: 'Paciente solicitó cancelar' } }),
      200,
      'RF11',
    );
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(cancelled.body.data.cancellation).toMatchObject({ reason: 'Paciente solicitó cancelar', cancelledBy: fixture.receptionists[0].subject });
    expect(await slotsOf()).toContain(current.startAt);
    const again = await api('POST', `/api/v1/appointments/${current.appointmentId}/cancel`, { token: receptionist, body: { reason: 'twice' } });
    expect([again.status, codeOf(again)]).toEqual([409, 'INVALID_STATE_TRANSITION']);
  });

  it('RF9 registers a new patient inside the booking (RF14 in the same operation)', async () => {
    const slots = await slotsOf();
    const startAt = String(slots.at(-1));
    const booked = expectStatus(
      await api<{ data: Appointment }>('POST', '/api/v1/appointments', {
        token: await tokenOf(fixture.receptionists[1]),
        idempotencyKey: true,
        body: {
          patient: {
            new: {
              identificationType: 'national_id',
              identificationNumber: `9-${Date.now() % 10_000}-${Math.floor(Math.random() * 10_000)}`,
              firstName: 'Luis',
              lastName: 'Inline',
              birthDate: '1985-01-20',
              contact: { phone: '+50677776666' },
            },
          },
          professionalId: professional.professionalId,
          serviceId: fixture.serviceId,
          startAt,
        },
      }),
      201,
      'RF9 + new patient',
    );
    inlinePatientBooking = booked.body.data;
    expect(inlinePatientBooking.status).toBe('booked');
    expect(expectStatus(await api('GET', `/api/v1/patients/${inlinePatientBooking.patientId}`, { token: receptionist }), 200).body).toMatchObject({
      data: { lastName: 'Inline' },
    });
  });

  it('RF12 records the outcome once the start time has passed; RF13 forbids a second outcome', async () => {
    const past = await insertPastAppointment({
      tenantId: fixture.tenantId,
      professionalId: professional.professionalId,
      serviceId: fixture.serviceId,
      patientId,
      bookedBy: fixture.receptionists[0].subject,
      daysAgo: 2,
      localTime: '09:00',
    });
    const attended = expectStatus(
      await api<{ data: Appointment }>('POST', `/api/v1/appointments/${past.appointmentId}/outcome`, { token: professionalToken, body: { outcome: 'attended' } }),
      200,
      'RF12',
    );
    expect(attended.body.data).toMatchObject({ status: 'attended', outcome: { recordedBy: professional.member.subject } });
    const twice = await api('POST', `/api/v1/appointments/${past.appointmentId}/outcome`, { token: professionalToken, body: { outcome: 'no_show' } });
    expect([twice.status, codeOf(twice)]).toEqual([409, 'INVALID_STATE_TRANSITION']);

    // RF15 on the attended appointment: written once by its professional, immutable afterwards.
    const note = expectStatus(
      await api<{ data: { noteId: string; authorSubject: string; content?: string } }>('POST', `/api/v1/appointments/${past.appointmentId}/clinical-note`, {
        token: professionalToken,
        body: { content: 'Paciente estable. Control en un mes.' },
      }),
      201,
      'RF15',
    );
    expect(note.body.data.authorSubject).toBe(professional.member.subject);
    expect(note.body.data.content).toBeUndefined(); // never echoed
    const duplicate = await api('POST', `/api/v1/appointments/${past.appointmentId}/clinical-note`, { token: professionalToken, body: { content: 'otra' } });
    expect([duplicate.status, codeOf(duplicate)]).toEqual([409, 'CLINICAL_NOTE_EXISTS']);
    const read = expectStatus(await api<{ data: { content: string } }>('GET', `/api/v1/appointments/${past.appointmentId}/clinical-note`, { token: professionalToken }), 200);
    expect(read.body.data.content).toBe('Paciente estable. Control en un mes.');
    const notAttended = await api('POST', `/api/v1/appointments/${inlinePatientBooking.appointmentId}/clinical-note`, { token: professionalToken, body: { content: 'x' } });
    expect([notAttended.status, codeOf(notAttended)]).toEqual([422, 'CLINICAL_NOTE_REQUIRES_ATTENDED']);
  });
});

describe('RF16, RF20, RF21: history, agenda and counts', () => {
  it('RF16 returns the patient history newest first with the status of each appointment', async () => {
    const history = expectStatus(await api<{ data: Appointment[] }>('GET', `/api/v1/patients/${patientId}/appointments`, { token: receptionist }), 200);
    const statuses = history.body.data.map((appointment) => [appointment.appointmentId, appointment.status]);
    expect(statuses).toEqual(
      expect.arrayContaining([
        [first.appointmentId, 'rescheduled'],
        [current.appointmentId, 'cancelled'],
      ]),
    );
    expect(history.body.data.some((appointment) => appointment.status === 'attended')).toBe(true);
    const starts = history.body.data.map((appointment) => new Date(appointment.startAt).getTime());
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
  });

  it('RF20 gives reception the clinic-wide day and forces professionals to their own agenda', async () => {
    const clinic = expectStatus(await api<{ data: { items: { appointmentId: string; status: string }[] } }>('GET', `/api/v1/agenda?date=${DATE}`, { token: receptionist }), 200);
    expect(clinic.body.data.items.map((item) => item.appointmentId)).toEqual(expect.arrayContaining([first.appointmentId, current.appointmentId, inlinePatientBooking.appointmentId]));
    const own = expectStatus(await api<{ data: { items: { professionalId: string }[] } }>('GET', `/api/v1/agenda?date=${DATE}`, { token: professionalToken }), 200);
    expect(own.body.data.items.length).toBeGreaterThan(0);
    expect(new Set(own.body.data.items.map((item) => item.professionalId))).toEqual(new Set([professional.professionalId]));
    const other = await api('GET', `/api/v1/agenda?date=${DATE}&professionalId=00000000-0000-4000-8000-000000000000`, { token: professionalToken });
    expect(other.status).toBe(403);
  });

  it('RF21 counts the appointments of the day by status', async () => {
    const counts = expectStatus(
      await api<{ data: { counts: Record<string, number>; total: number } }>(
        'GET',
        `/api/v1/reports/appointment-status-counts?from=${DATE}&to=${DATE}&professionalId=${professional.professionalId}`,
        { token: receptionist },
      ),
      200,
    );
    expect(counts.body.data.counts).toEqual({ booked: 1, attended: 0, no_show: 0, cancelled: 1, rescheduled: 1 });
    expect(counts.body.data.total).toBe(3);
  });
});

describe('RF5/RF6: blocks and schedule changes list conflicts and never cancel bookings', () => {
  it('RF6 withdraws availability, lists the booked appointment as a conflict, and is reversible', async () => {
    const start = new Date(inlinePatientBooking.startAt);
    const blockStart = new Date(start.getTime() - 60 * 60_000).toISOString();
    const blockEnd = new Date(start.getTime() + 60 * 60_000).toISOString();
    const block = expectStatus(
      await api<{ data: { blockId: string; conflicts: { appointmentId: string }[] } }>('POST', `/api/v1/professionals/${professional.professionalId}/calendar-blocks`, {
        token: admin,
        body: { startAt: blockStart, endAt: blockEnd, reason: 'leave', note: 'Permiso' },
      }),
      201,
      'RF6',
    );
    expect(block.body.data.conflicts.map((conflict) => conflict.appointmentId)).toEqual([inlinePatientBooking.appointmentId]);
    expect(expectStatus(await api<{ data: Appointment }>('GET', `/api/v1/appointments/${inlinePatientBooking.appointmentId}`, { token: receptionist }), 200).body.data.status).toBe('booked');
    const conflicts = expectStatus(
      await api<{ data: { appointment: { appointmentId: string }; reasons: string[] }[] }>('GET', `/api/v1/schedule-conflicts?professionalId=${professional.professionalId}&from=${DATE}&to=${DATE}`, {
        token: receptionist,
      }),
      200,
    );
    expect(conflicts.body.data).toContainEqual({ appointment: expect.objectContaining({ appointmentId: inlinePatientBooking.appointmentId }), reasons: ['CALENDAR_BLOCK'] });
    const blocked = await slotsOf();
    expect(blocked.some((slot) => new Date(slot) >= new Date(blockStart) && new Date(slot) < new Date(blockEnd))).toBe(false);
    expect(blocked.length).toBeGreaterThan(0);
    expectStatus(await api('DELETE', `/api/v1/professionals/${professional.professionalId}/calendar-blocks/${block.body.data.blockId}`, { token: admin }), 204);
    expect((await slotsOf()).some((slot) => new Date(slot) >= new Date(blockStart) && new Date(slot) < new Date(blockEnd))).toBe(true);
  });

  it('RF5 removing the working day lists the appointment as OUTSIDE_WORKING_HOURS; the professional may manage their own schedule', async () => {
    const weekday = isoWeekday(DATE);
    const changed = expectStatus(
      await api<{ data: { conflicts: { appointmentId: string }[] } }>('PUT', `/api/v1/professionals/${professional.professionalId}/weekly-schedule`, {
        token: professionalToken, // schedule:manage-own
        body: { blocks: DEFAULT_WEEK.filter((block) => block.dayOfWeek !== weekday) },
      }),
      200,
      'RF5 own',
    );
    expect(changed.body.data.conflicts.map((conflict) => conflict.appointmentId)).toContain(inlinePatientBooking.appointmentId);
    expect(await slotsOf()).toEqual([]);
    const overlapping = await api('PUT', `/api/v1/professionals/${professional.professionalId}/weekly-schedule`, {
      token: admin,
      body: { blocks: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }, { dayOfWeek: 1, startTime: '11:00', endTime: '13:00' }] },
    });
    expect([overlapping.status, codeOf(overlapping)]).toEqual([409, 'SCHEDULE_OVERLAP']);
    expectStatus(await api('PUT', `/api/v1/professionals/${professional.professionalId}/weekly-schedule`, { token: admin, body: { blocks: DEFAULT_WEEK } }), 200);
    expect((await slotsOf()).length).toBeGreaterThan(0);
  });
});

describe('RF2: role assignment and logical deactivation', () => {
  it('changes a role, deactivates the user and Keycloak stops issuing tokens to them', async () => {
    const member = await createStaff(fixture.admin, 'receptionist', fixture.emailDomain, 'Temporal Baja');
    expect((await api<{ data: { roles: string[] } }>('GET', '/api/v1/me', { token: await passwordToken(member.email, member.password) })).body.data.roles).toEqual(['receptionist']);
    const promoted = expectStatus(await api<{ data: { role: string } }>('PATCH', `/api/v1/users/${member.userId}/role`, { token: admin, idempotencyKey: true, body: { role: 'clinic_admin' } }), 200);
    expect(promoted.body.data.role).toBe('clinic_admin');
    expect((await api<{ data: { roles: string[] } }>('GET', '/api/v1/me', { token: await passwordToken(member.email, member.password) })).body.data.roles).toEqual(['clinic_admin']);
    const deactivated = expectStatus(await api<{ data: { status: string } }>('POST', `/api/v1/users/${member.userId}/deactivate`, { token: admin, idempotencyKey: true }), 200);
    expect(deactivated.body.data.status).toBe('inactive');
    await expect(passwordToken(member.email, member.password)).rejects.toThrow(/failed with HTTP (400|401)/);
    const again = await api('POST', `/api/v1/users/${member.userId}/deactivate`, { token: admin, idempotencyKey: true });
    expect([again.status, codeOf(again)]).toEqual([409, 'INVALID_STATE_TRANSITION']);
  });
});
