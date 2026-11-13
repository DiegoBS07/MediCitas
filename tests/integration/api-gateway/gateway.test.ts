import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningService } from '@medicitas/runtime';
import { startGateway } from '../../../application-plane/api-gateway/src/service.js';
import { startAppointmentOrchestrator } from '../../../application-plane/appointment-orchestrator/src/service.js';
import { startCatalogService } from '../../../application-plane/catalog-service-management/src/service.js';
import { startScheduler } from '../../../application-plane/scheduler-management/src/service.js';
import { startUserManagement } from '../../../application-plane/user-management/src/service.js';
import { startTenantManagement } from '../../../control-plane/tenant-management/src/service.js';
import { CLINIC_1, ownerPool } from '../../support/database.js';
import { HOST, env } from '../../support/env.js';
import { localDate, schedulerConfig } from '../../support/scheduler.js';
import { httpClient, serviceConfig } from '../../support/services.js';
import { tokenOf } from '../../support/tokens.js';

const TZ = 'America/Costa_Rica';
const PROFESSIONAL_1 = '42000000-0000-4000-8000-000000010001';
const GENERAL_CONSULTATION = '41000000-0000-4000-8000-000000010001';
const runId = randomUUID().slice(0, 6);
const userOwner = ownerPool('um', 'medicitas_user');

let services: RunningService[] = [];
let gateway: RunningService;
let api: ReturnType<typeof httpClient>;
let receptionist: string;
let admin: string;

beforeAll(async () => {
  const [tenants, users, catalog, scheduler, booking] = await Promise.all([
    startTenantManagement(serviceConfig('tm', 'medicitas_tenant', 'tenant-management')),
    startUserManagement(serviceConfig('um', 'medicitas_user', 'user-management')),
    startCatalogService(serviceConfig('cat', 'medicitas_catalog', 'catalog-service-management')),
    startScheduler(schedulerConfig()),
    startAppointmentOrchestrator({
      ...serviceConfig('ao', 'medicitas_appointment_orchestrator', 'appointment-orchestrator'),
      saga: { deadlineMs: 15_000, syncWaitMs: 8_000, resendMs: 5_000, compensationWindowMs: 30_000 },
      sweepIntervalMs: 1_000,
    }),
  ]);
  services = [tenants, users, catalog, scheduler, booking];
  const url = (service: RunningService): string => `http://${HOST}:${service.port}`;
  const keycloak = env('KEYCLOAK_PUBLIC_URL');
  gateway = await startGateway({
    port: 0,
    logLevel: process.env['TEST_LOG_LEVEL'] ?? 'silent',
    identity: { jwksUrl: `${keycloak}/realms/medicitas/protocol/openid-connect/certs`, issuer: `${keycloak}/realms/medicitas`, audience: 'medicitas-api' },
    upstreamTimeoutMs: 20_000,
    upstreams: {
      'tenant-management': url(tenants),
      // Deliberately unreachable: proves 503 DEPENDENCY_UNAVAILABLE for a down upstream.
      'onboarding-orchestrator': `http://${HOST}:1`,
      'user-management': url(users),
      'user-management-orchestrator': `http://${HOST}:1`,
      'catalog-service-management': url(catalog),
      'scheduler-management': url(scheduler),
      'appointment-orchestrator': url(booking),
    },
  });
  api = httpClient(gateway.port);
  [receptionist, admin] = await Promise.all([tokenOf('clinic1Receptionist'), tokenOf('clinic1Admin')]);
}, 60_000);

afterAll(async () => {
  await gateway.stop();
  for (const service of [...services].reverse()) await service.stop();
  await userOwner.query(`DELETE FROM identity.patients WHERE identification_number LIKE 'IT-%'`);
  await userOwner.end();
});

describe('API gateway: authentication, authorization and routing (RF17)', () => {
  it('exposes health without a token and requires a valid bearer token on /api', async () => {
    expect((await api('GET', '/health/live')).status).toBe(200);
    expect((await api('GET', '/health/ready')).body).toEqual({ status: 'ok' });
    expect((await api('GET', '/api/v1/me')).body).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect((await api('GET', '/api/v1/me', { token: 'not.a.jwt' })).body).toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('builds the TenantContext from the token only (GET /me)', async () => {
    const me = await api<{ data: { tenantId: string | null; roles: string[]; permissions: string[] } }>('GET', '/api/v1/me', { token: receptionist });
    expect(me.body.data).toMatchObject({ tenantId: CLINIC_1, roles: ['receptionist'] });
    expect(me.body.data.permissions).toContain('appointments:book');
    expect(me.body.data.permissions).not.toContain('users:manage');
    const platform = await api<{ data: { tenantId: string | null } }>('GET', '/api/v1/me', { token: await tokenOf('platformAdmin') });
    expect(platform.body.data.tenantId).toBeNull();
  });

  it('answers 403 for a valid token without the permission, 404 for unknown routes and 405 for wrong methods', async () => {
    expect((await api('GET', '/api/v1/patients', { token: await tokenOf('platformAdmin') })).status).toBe(403);
    expect((await api('GET', '/api/v1/users', { token: receptionist })).status).toBe(403);
    expect((await api('GET', '/api/v1/tenants', { token: receptionist })).status).toBe(403);
    expect((await api('GET', '/api/v1/nothing-here', { token: receptionist })).body).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
    const wrongMethod = await api('DELETE', '/api/v1/patients', { token: receptionist });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST, GET');
  });

  it('ignores tenant headers injected by the client and propagates the correlation id', async () => {
    const spoofed = await api('GET', '/api/v1/patients/50000000-0000-4000-8000-000200000001', {
      token: receptionist,
      headers: { 'X-Tenant-Id': '10000000-0000-4000-8000-000000000002', 'X-User-Role': 'clinic_admin' },
    });
    expect(spoofed.status).toBe(404);
    const correlationId = randomUUID();
    const invalid = await api('GET', '/api/v1/services/not-a-uuid', { token: receptionist, headers: { 'X-Correlation-Id': correlationId } });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('x-correlation-id')).toBe(correlationId);
    expect(invalid.body).toMatchObject({ correlationId });
  });

  it('answers 503 DEPENDENCY_UNAVAILABLE when the owning service cannot be reached', async () => {
    const response = await api('POST', '/api/v1/tenants', {
      token: await tokenOf('platformAdmin'),
      body: { name: 'x' },
      headers: { 'Idempotency-Key': `it-gw-${runId}-0000001` },
    });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(response.headers.get('retry-after')).not.toBeNull();
  });
});

describe('end to end through the gateway: patient, availability, booking, cache, cancellation, audited denial', () => {
  it('books the first free slot of a seeded professional and frees it again', async () => {
    const patient = await api<{ data: { patientId: string } }>('POST', '/api/v1/patients', {
      token: receptionist,
      body: { identificationType: 'passport', identificationNumber: `IT-${runId}-gw`, firstName: 'Gate', lastName: 'Way', birthDate: '1991-03-03' },
    });
    expect(patient.status).toBe(201);
    const patientId = patient.body.data.patientId;

    const search = await api<{ data: { professionals: { professionalId: string; days: { date: string; slots: { startAt: string }[] }[] }[] } }>(
      'GET',
      `/api/v1/availability/search?serviceId=${GENERAL_CONSULTATION}&from=${localDate(TZ, 14)}&to=${localDate(TZ, 20)}`,
      { token: receptionist },
    );
    expect(search.status).toBe(200);
    const day = search.body.data.professionals.find((professional) => professional.professionalId === PROFESSIONAL_1)?.days[0];
    const slot = day?.slots[0];
    expect(slot).toBeDefined();
    const startAt = String(slot?.startAt);

    const booked = await api<{ data: { appointmentId: string; status: string } }>('POST', '/api/v1/appointments', {
      token: receptionist,
      body: { patient: { id: patientId }, professionalId: PROFESSIONAL_1, serviceId: GENERAL_CONSULTATION, startAt },
      headers: { 'Idempotency-Key': `it-gw-${runId}-booking` },
    });
    expect(booked.status).toBe(201);
    const appointmentId = booked.body.data.appointmentId;
    expect(booked.headers.get('location')).toBe(`/api/v1/appointments/${appointmentId}`);

    const availability = await api<{ data: { slots: { startAt: string }[] } }>(
      'GET',
      `/api/v1/availability?professionalId=${PROFESSIONAL_1}&serviceId=${GENERAL_CONSULTATION}&date=${day?.date ?? ''}`,
      { token: receptionist },
    );
    expect(availability.headers.get('x-cache')).not.toBeNull();
    expect(availability.body.data.slots.some((candidate) => candidate.startAt === startAt)).toBe(false);

    // Clinic admin is a clinic user: the gateway lets the note route through, the scheduler denies AND audits it.
    const denied = await api('POST', `/api/v1/appointments/${appointmentId}/clinical-note`, { token: admin, body: { content: 'x' } });
    expect(denied.status).toBe(403);
    const audit = await api<{ data: { action: string; outcome: string; actorRole: string }[] }>('GET', `/api/v1/audit-log?patientId=${patientId}&resourceType=clinical_note`, {
      token: admin,
    });
    expect(audit.body.data).toContainEqual(expect.objectContaining({ action: 'create', outcome: 'denied', actorRole: 'clinic_admin' }));

    const cancelled = await api<{ data: { status: string } }>('POST', `/api/v1/appointments/${appointmentId}/cancel`, {
      token: receptionist,
      body: { reason: 'Integration test cleanup' },
    });
    expect(cancelled.body.data.status).toBe('cancelled');
    const freed = await api<{ data: { slots: { startAt: string }[] } }>(
      'GET',
      `/api/v1/availability?professionalId=${PROFESSIONAL_1}&serviceId=${GENERAL_CONSULTATION}&date=${day?.date ?? ''}`,
      { token: receptionist },
    );
    expect(freed.body.data.slots.some((candidate) => candidate.startAt === startAt)).toBe(true);
  });
});
