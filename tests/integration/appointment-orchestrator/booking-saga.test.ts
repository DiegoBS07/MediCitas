import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXCHANGES } from '@medicitas/messaging';
import type { RunningService } from '@medicitas/runtime';
import { startAppointmentOrchestrator, type AppointmentOrchestratorConfig } from '../../../application-plane/appointment-orchestrator/src/service.js';
import { startCatalogService } from '../../../application-plane/catalog-service-management/src/service.js';
import { startScheduler } from '../../../application-plane/scheduler-management/src/service.js';
import { startUserManagement } from '../../../application-plane/user-management/src/service.js';
import { CLINIC_1, ownerPool } from '../../support/database.js';
import { MessageTap, ServiceProbe, httpClient, serviceConfig } from '../../support/services.js';
import { crInstant, localDate, schedulerConfig, waitForReplica } from '../../support/scheduler.js';
import { tokenOf } from '../../support/tokens.js';

const TZ = 'America/Costa_Rica';
const ADMIN_1 = { subject: '30000000-0000-4000-8000-000000010001', roles: ['clinic_admin' as const] };
const INACTIVE_PATIENT = '50000000-0000-4000-8000-000100000120';
const GENERAL_CONSULTATION = '41000000-0000-4000-8000-000000010001';
const runId = randomUUID().slice(0, 6);
const day = localDate(TZ, 4);
const schedulerOwner = ownerPool('sch', 'medicitas_scheduler');
const catalogOwner = ownerPool('cat', 'medicitas_catalog');
const userOwner = ownerPool('um', 'medicitas_user');

function orchestratorConfig(syncWaitMs = 8_000): AppointmentOrchestratorConfig {
  return {
    ...serviceConfig('ao', 'medicitas_appointment_orchestrator', 'appointment-orchestrator'),
    saga: { deadlineMs: 15_000, syncWaitMs, resendMs: 5_000, compensationWindowMs: 30_000 },
    sweepIntervalMs: 1_000,
  };
}

let services: RunningService[] = [];
let booking: ReturnType<typeof httpClient>;
let catalogHttp: ReturnType<typeof httpClient>;
let schedulerHttp: ReturnType<typeof httpClient>;
let usersHttp: ReturnType<typeof httpClient>;
let umo: ServiceProbe;
let replies: MessageTap;
let events: MessageTap;
let admin: string;
let receptionist: string;
let professionalId: string;
let serviceId: string;

interface AppointmentBody {
  readonly data: { readonly appointmentId: string; readonly status: string; readonly durationMinutes: number; readonly patientId: string };
}

async function provisionProfessionalUser(): Promise<string> {
  const userId = randomUUID();
  for (const [messageType, routingKey, payload] of [
    [
      'ReserveUserCommand',
      'user-management.user.reserve',
      { userId, email: `saga.${runId}@it.medicitas.test`, firstName: 'Saga', lastName: 'Doctor', role: 'health_professional' },
    ],
    ['ActivateUserCommand', 'user-management.user.activate', { userId, keycloakSubject: randomUUID() }],
  ] as const) {
    const command = umo.envelope({ messageType, tenantId: CLINIC_1, actor: ADMIN_1, sagaId: randomUUID(), replyTo: 'user-management-orchestrator', payload });
    await umo.command(routingKey, command);
    expect((await replies.waitFor((message) => message.commandId === command.messageId)).payload).toMatchObject({ outcome: 'succeeded' });
  }
  return userId;
}

async function newPatientId(suffix: string): Promise<string> {
  const response = await usersHttp<{ data: { patientId: string } }>('POST', '/api/v1/patients', {
    token: receptionist,
    body: {
      identificationType: 'passport',
      identificationNumber: `IT-${runId}-${suffix}`,
      firstName: 'Saga',
      lastName: `Paciente${suffix}`,
      birthDate: '1985-06-01',
    },
  });
  expect(response.status).toBe(201);
  return response.body.data.patientId;
}

const book = (body: Record<string, unknown>, key: string | null = `it-book-${randomUUID()}`, token = receptionist) =>
  booking<AppointmentBody & { code?: string; details?: Record<string, string> }>('POST', '/api/v1/appointments', {
    token,
    body,
    ...(key === null ? {} : { headers: { 'Idempotency-Key': key } }),
  });

const request = (patient: Record<string, unknown>, time: string, overrides: Record<string, unknown> = {}) => ({
  patient,
  professionalId,
  serviceId,
  startAt: crInstant(day, time),
  ...overrides,
});

beforeAll(async () => {
  const [users, catalog, scheduler, orchestrator] = await Promise.all([
    startUserManagement(serviceConfig('um', 'medicitas_user', 'user-management')),
    startCatalogService(serviceConfig('cat', 'medicitas_catalog', 'catalog-service-management')),
    startScheduler(schedulerConfig()),
    startAppointmentOrchestrator(orchestratorConfig()),
  ]);
  services = [users, catalog, scheduler, orchestrator];
  usersHttp = httpClient(users.port);
  catalogHttp = httpClient(catalog.port);
  schedulerHttp = httpClient(scheduler.port);
  booking = httpClient(orchestrator.port);
  umo = new ServiceProbe('user-management-orchestrator');
  await umo.ready();
  replies = await MessageTap.open([{ exchange: EXCHANGES.replies, routingKey: 'user-management-orchestrator' }]);
  events = await MessageTap.open([{ exchange: EXCHANGES.events, routingKey: 'booking.#' }]);
  [admin, receptionist] = await Promise.all([tokenOf('clinic1Admin'), tokenOf('clinic1Receptionist')]);

  // Real catalog through its API; the events feed the scheduler replicas (decision D4).
  const specialty = await catalogHttp<{ data: { specialtyId: string } }>('POST', '/api/v1/specialties', { token: admin, body: { name: `IT Saga ${runId}` } });
  const service = await catalogHttp<{ data: { serviceId: string } }>('POST', '/api/v1/services', {
    token: admin,
    body: { name: `IT Saga visit ${runId}`, specialtyId: specialty.body.data.specialtyId, durationMinutes: 30 },
  });
  serviceId = service.body.data.serviceId;
  const professional = await catalogHttp<{ data: { professionalId: string } }>('POST', '/api/v1/professionals', {
    token: admin,
    body: { userId: await provisionProfessionalUser(), specialtyId: specialty.body.data.specialtyId, displayName: `IT Saga Dr ${runId}`, licenseNumber: `IT-S-${runId}` },
  });
  professionalId = professional.body.data.professionalId;
  expect((await catalogHttp('PUT', `/api/v1/professionals/${professionalId}/services`, { token: admin, body: { serviceIds: [serviceId] } })).status).toBe(200);
  await waitForReplica(schedulerOwner, professionalId, serviceId);
  const schedule = await schedulerHttp('PUT', `/api/v1/professionals/${professionalId}/weekly-schedule`, {
    token: admin,
    body: { blocks: Array.from({ length: 7 }, (_, index) => ({ dayOfWeek: index + 1, startTime: '07:00', endTime: '19:00' })) },
  });
  expect(schedule.status).toBe(200);
}, 90_000);

afterAll(async () => {
  for (const service of services.reverse()) await service.stop();
  for (const closable of [umo, replies, events]) await closable.close();
  // Catalog/user fixtures are removable; scheduler appointments are append-only history and stay.
  await userOwner.query(`DELETE FROM identity.patients WHERE identification_number LIKE 'IT-%'`);
  await userOwner.query(`DELETE FROM identity.users WHERE email LIKE '%@it.medicitas.test'`);
  await Promise.all([schedulerOwner.end(), catalogOwner.end(), userOwner.end()]);
});

describe('RF9 booking saga — the three required outcomes', () => {
  it('grants a booking (201) and replays it for the same Idempotency-Key', async () => {
    const patientId = await newPatientId('a');
    const key = `it-book-${runId}-granted`;
    const body = request({ id: patientId }, '08:00');
    const granted = await book(body, key);
    expect(granted.status).toBe(201);
    expect(granted.body.data).toMatchObject({ status: 'booked', durationMinutes: 30, patientId });
    expect(granted.headers.get('location')).toBe(`/api/v1/appointments/${granted.body.data.appointmentId}`);

    const replay = await book(body, key);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body.data.appointmentId).toBe(granted.body.data.appointmentId);
    const reused = await book(request({ id: patientId }, '08:30'), key);
    expect(reused.status).toBe(422);
    expect(reused.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const detail = await schedulerHttp<{ data: { status: string } }>('GET', `/api/v1/appointments/${granted.body.data.appointmentId}`, { token: receptionist });
    expect(detail.body.data.status).toBe('booked');
  });

  it('answers 409 SLOT_TAKEN to the loser of two receptionists racing for the same slot', async () => {
    const [first, second] = await Promise.all([newPatientId('b'), newPatientId('c')]);
    const [carlos, laura] = await Promise.all([tokenOf('clinic1Receptionist'), tokenOf('clinic1Receptionist2')]);
    const results = await Promise.all([book(request({ id: first }, '09:00'), undefined, carlos), book(request({ id: second }, '09:00'), undefined, laura)]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)?.body).toMatchObject({ code: 'SLOT_TAKEN' });
  });

  it('rejects invalid requests (400/422/404) and never accepts a client-sent duration (I4)', async () => {
    const patientId = await newPatientId('d');
    expect((await book(request({ id: patientId }, '10:00'), null)).body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect((await book(request({ id: patientId }, '10:00', { durationMinutes: 90 }))).status).toBe(400);
    expect((await book(request({ id: patientId }, '10:00', { endAt: crInstant(day, '12:00') }))).status).toBe(400);
    const misaligned = await book(request({ id: patientId }, '10:05'));
    expect(misaligned.status).toBe(422);
    expect(misaligned.body).toMatchObject({ code: 'SLOT_MISALIGNED' });
    const notQualified = await book(request({ id: patientId }, '10:00', { serviceId: GENERAL_CONSULTATION }));
    expect(notQualified.status).toBe(422);
    expect(notQualified.body).toMatchObject({ code: 'PROFESSIONAL_NOT_QUALIFIED' });
    const unknownPatient = await book(request({ id: randomUUID() }, '10:00'));
    expect(unknownPatient.status).toBe(404);
    expect((await book(request({ id: patientId }, '10:00'), undefined, await tokenOf('clinic1Professional1'))).status).toBe(403);
  });

  it('compensates a held slot when another participant rejects, and announces the failure', async () => {
    const failed = await book(request({ id: INACTIVE_PATIENT }, '11:00'));
    expect(failed.status).toBe(422);
    expect(failed.body).toMatchObject({ code: 'PATIENT_INACTIVE' });
    // The slot that was held in parallel is released: it is available again immediately.
    const availability = await schedulerHttp<{ data: { slots: { startAt: string }[] } }>(
      'GET',
      `/api/v1/availability?professionalId=${professionalId}&serviceId=${serviceId}&date=${day}`,
      { token: receptionist },
    );
    expect(availability.body.data.slots.some((slot) => Date.parse(slot.startAt) === Date.parse(crInstant(day, '11:00')))).toBe(true);
    await events.waitFor((message) => message.messageType === 'AppointmentBookingFailed' && message.payload['reasonCode'] === 'PATIENT_INACTIVE');
  });

  it('registers a new patient inside the booking (P2) and reports an existing identification', async () => {
    const identification = `IT-${runId}-new`;
    const created = await book(
      request(
        { new: { identificationType: 'national_id', identificationNumber: identification, firstName: 'Nueva', lastName: 'Paciente', birthDate: '1992-02-02', contact: { phone: '+50670001111' } } },
        '12:00',
      ),
    );
    expect(created.status).toBe(201);
    const patient = await usersHttp('GET', `/api/v1/patients/${created.body.data.patientId}`, { token: receptionist });
    expect(patient.status).toBe(200);

    const clash = await book(
      request({ new: { identificationType: 'national_id', identificationNumber: identification, firstName: 'Otra', lastName: 'Persona', birthDate: '1990-01-01' } }, '13:00'),
    );
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ code: 'PATIENT_IDENTIFICATION_TAKEN', details: { patientId: created.body.data.patientId } });
  });

  it('answers 202 with a pollable operation when the saga outlives the synchronous wait', async () => {
    const quick = await startAppointmentOrchestrator(orchestratorConfig(0));
    try {
      const client = httpClient(quick.port);
      const accepted = await client<{ data: { operationId: string; status: string } }>('POST', '/api/v1/appointments', {
        token: receptionist,
        body: request({ id: await newPatientId('e') }, '14:00'),
        headers: { 'Idempotency-Key': `it-book-${runId}-accepted` },
      });
      expect(accepted.status).toBe(202);
      expect(accepted.body.data.status).toBe('running');
      const location = accepted.headers.get('location') ?? '';
      expect(location).toBe(`/api/v1/appointment-operations/${accepted.body.data.operationId}`);
      await expect
        .poll(async () => (await client<{ data: { status: string } }>('GET', location, { token: receptionist })).body.data.status, { timeout: 15_000 })
        .toBe('completed');
      const foreign = await client('GET', location, { token: await tokenOf('clinic2Receptionist') });
      expect(foreign.status).toBe(404);
    } finally {
      await quick.stop();
    }
  });
});
