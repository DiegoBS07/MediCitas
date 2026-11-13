import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXCHANGES, type Envelope } from '@medicitas/messaging';
import type { RunningService } from '@medicitas/runtime';
import { startCatalogService } from '../../../application-plane/catalog-service-management/src/service.js';
import { startUserManagement } from '../../../application-plane/user-management/src/service.js';
import { CLINIC_1, ownerPool } from '../../support/database.js';
import { MessageTap, ServiceProbe, httpClient, serviceConfig } from '../../support/services.js';
import { tokenOf } from '../../support/tokens.js';

const ids = {
  generalMedicine: '40000000-0000-4000-8000-000000010001',
  pediatrics: '40000000-0000-4000-8000-000000010002',
  generalConsultation: '41000000-0000-4000-8000-000000010001',
  pediatricConsultation: '41000000-0000-4000-8000-000000010003',
  clinic2Service: '41000000-0000-4000-8000-000000020001',
  professional1: '42000000-0000-4000-8000-000000010001',
  clinic2Professional: '42000000-0000-4000-8000-000000020001',
  receptionistUser: '20000000-0000-4000-8000-000000010002',
};
const ADMIN_1 = { subject: '30000000-0000-4000-8000-000000010001', roles: ['clinic_admin' as const] };
const RECEPTIONIST_1 = { subject: '30000000-0000-4000-8000-000000010002', roles: ['receptionist' as const] };
const runId = randomUUID().slice(0, 6);
const catalogOwner = ownerPool('cat', 'medicitas_catalog');
const userOwner = ownerPool('um', 'medicitas_user');

let catalog: RunningService;
let users: RunningService;
let http: ReturnType<typeof httpClient>;
let adminToken: string;
let umo: ServiceProbe;
let booking: ServiceProbe;
let userEvents: ServiceProbe;
let replies: MessageTap;
let events: MessageTap;

beforeAll(async () => {
  [catalog, users] = await Promise.all([
    startCatalogService(serviceConfig('cat', 'medicitas_catalog', 'catalog-service-management')),
    startUserManagement(serviceConfig('um', 'medicitas_user', 'user-management')),
  ]);
  http = httpClient(catalog.port);
  adminToken = await tokenOf('clinic1Admin');
  umo = new ServiceProbe('user-management-orchestrator');
  booking = new ServiceProbe('appointment-orchestrator');
  userEvents = new ServiceProbe('user-management');
  await Promise.all([umo.ready(), booking.ready(), userEvents.ready()]);
  replies = await MessageTap.open([
    { exchange: EXCHANGES.replies, routingKey: 'user-management-orchestrator' },
    { exchange: EXCHANGES.replies, routingKey: 'appointment-orchestrator' },
  ]);
  events = await MessageTap.open([{ exchange: EXCHANGES.events, routingKey: 'catalog.#' }]);
});

afterAll(async () => {
  await catalogOwner.query(
    `DELETE FROM catalog.professional_services WHERE professional_id IN (SELECT id FROM catalog.professionals WHERE display_name LIKE 'IT %')
        OR service_id IN (SELECT id FROM catalog.services WHERE name LIKE 'IT %')`,
  );
  await catalogOwner.query(`DELETE FROM catalog.professionals WHERE display_name LIKE 'IT %'`);
  await catalogOwner.query(`DELETE FROM catalog.services WHERE name LIKE 'IT %'`);
  await catalogOwner.query(`DELETE FROM catalog.specialties WHERE name LIKE 'IT %'`);
  await userOwner.query(`DELETE FROM identity.users WHERE email LIKE '%@it.medicitas.test'`);
  await Promise.all([catalogOwner.end(), userOwner.end()]);
  for (const closable of [replies, events, umo, booking, userEvents]) await closable.close();
  await Promise.all([catalog.stop(), users.stop()]);
});

const replyOf = (command: Envelope) => replies.waitFor((message) => message.commandId === command.messageId);

/** Provisions an active health professional user through the real user-management commands. */
async function provisionProfessionalUser(): Promise<string> {
  const userId = randomUUID();
  const reserve = umo.envelope({
    messageType: 'ReserveUserCommand',
    tenantId: CLINIC_1,
    actor: ADMIN_1,
    sagaId: randomUUID(),
    replyTo: 'user-management-orchestrator',
    payload: { userId, email: `pro.${runId}.${userId.slice(0, 4)}@it.medicitas.test`, firstName: 'Pro', lastName: 'Fesional', role: 'health_professional' },
  });
  await umo.command('user-management.user.reserve', reserve);
  await replyOf(reserve);
  const activate = umo.envelope({
    messageType: 'ActivateUserCommand',
    tenantId: CLINIC_1,
    actor: ADMIN_1,
    replyTo: 'user-management-orchestrator',
    payload: { userId, keycloakSubject: randomUUID() },
  });
  await umo.command('user-management.user.activate', activate);
  expect((await replyOf(activate)).payload).toMatchObject({ outcome: 'succeeded' });
  return userId;
}

describe('catalog reads (RF3, RF4) and isolation', () => {
  it('lets every clinical role read the catalog of its own tenant only', async () => {
    const token = await tokenOf('clinic1Receptionist');
    const list = await http<{ data: { serviceId: string; durationMinutes: number }[] }>('GET', '/api/v1/services?status=active&limit=100', { token });
    expect(list.status).toBe(200);
    expect(list.body.data.map((service) => service.serviceId)).toContain(ids.generalConsultation);
    expect(list.body.data.map((service) => service.serviceId)).not.toContain(ids.clinic2Service);
    expect((await http('GET', `/api/v1/services/${ids.clinic2Service}`, { token })).status).toBe(404);
    const offered = await http<{ data: { serviceId: string }[] }>('GET', `/api/v1/professionals/${ids.professional1}/services`, { token });
    expect(offered.body.data.map((service) => service.serviceId)).toContain(ids.generalConsultation);
    const byService = await http<{ data: { professionalId: string }[] }>('GET', `/api/v1/professionals?serviceId=${ids.generalConsultation}`, {
      token: await tokenOf('clinic1Professional2'),
    });
    expect(byService.body.data.map((professional) => professional.professionalId)).toEqual([ids.professional1]);
  });

  it('reserves catalog writes for the clinic admin', async () => {
    const response = await http('POST', '/api/v1/specialties', { token: await tokenOf('clinic1Receptionist'), body: { name: 'IT forbidden' } });
    expect(response.status).toBe(403);
  });
});

describe('catalog writes (RF3)', () => {
  it('creates specialties and services, validates durations and announces changes', async () => {
    const specialty = await http<{ data: { specialtyId: string } }>('POST', '/api/v1/specialties', {
      token: adminToken,
      body: { name: `IT Cardiology ${runId}` },
    });
    expect(specialty.status).toBe(201);
    const duplicate = await http('POST', '/api/v1/specialties', { token: adminToken, body: { name: `it cardiology ${runId}` } });
    expect(duplicate.body).toMatchObject({ code: 'SPECIALTY_NAME_TAKEN' });

    const badDuration = await http('POST', '/api/v1/services', {
      token: adminToken,
      body: { name: `IT Echo ${runId}`, specialtyId: specialty.body.data.specialtyId, durationMinutes: 7 },
    });
    expect(badDuration.status).toBe(400);
    const foreignSpecialty = await http('POST', '/api/v1/services', {
      token: adminToken,
      body: { name: `IT Echo ${runId}`, specialtyId: '40000000-0000-4000-8000-000000020001', durationMinutes: 30 },
    });
    expect(foreignSpecialty.status).toBe(404);

    const service = await http<{ data: { serviceId: string; version: number } }>('POST', '/api/v1/services', {
      token: adminToken,
      body: { name: `IT Echo ${runId}`, specialtyId: specialty.body.data.specialtyId, durationMinutes: 25 },
      headers: { 'Idempotency-Key': `it-service-${runId}-0001` },
    });
    expect(service.status).toBe(201);
    expect(service.headers.get('location')).toBe(`/api/v1/services/${service.body.data.serviceId}`);
    const serviceId = service.body.data.serviceId;
    await events.waitFor((message) => message.messageType === 'ServiceCreated' && message.payload['serviceId'] === serviceId);

    const patched = await http<{ data: { durationMinutes: number; version: number } }>('PATCH', `/api/v1/services/${serviceId}`, {
      token: adminToken,
      body: { durationMinutes: 40 },
    });
    expect(patched.body.data).toMatchObject({ durationMinutes: 40, version: 2 });
    const updated = await events.waitFor((message) => message.messageType === 'ServiceUpdated' && message.payload['serviceId'] === serviceId);
    expect(updated.payload).toMatchObject({ durationMinutes: 40, aggregateVersion: 2, status: 'active' });

    await http('PATCH', `/api/v1/services/${serviceId}`, { token: adminToken, body: { status: 'inactive' } });
    await events.waitFor((message) => message.messageType === 'ServiceDeactivated' && message.payload['serviceId'] === serviceId);
  });
});

describe('professionals (RF4)', () => {
  it('registers an eligible user (checked through a correlated query) and rejects ineligible ones', async () => {
    const userId = await provisionProfessionalUser();
    const body = { userId, specialtyId: ids.generalMedicine, displayName: `IT Dr. ${runId}`, licenseNumber: `IT-${runId}` };
    const created = await http<{ data: { professionalId: string; status: string } }>('POST', '/api/v1/professionals', { token: adminToken, body });
    expect(created.status).toBe(201);
    await events.waitFor(
      (message) => message.messageType === 'ProfessionalRegistered' && message.payload['professionalId'] === created.body.data.professionalId,
    );
    const again = await http('POST', '/api/v1/professionals', { token: adminToken, body: { ...body, licenseNumber: `IT-${runId}-B` } });
    expect(again.body).toMatchObject({ code: 'PROFESSIONAL_ALREADY_REGISTERED' });

    const receptionist = await http('POST', '/api/v1/professionals', {
      token: adminToken,
      body: { ...body, userId: ids.receptionistUser, licenseNumber: `IT-${runId}-C` },
    });
    expect(receptionist.status).toBe(422);
    expect(receptionist.body).toMatchObject({ code: 'USER_NOT_ELIGIBLE' });

    const unknown = await http('POST', '/api/v1/professionals', {
      token: adminToken,
      body: { ...body, userId: randomUUID(), licenseNumber: `IT-${runId}-D` },
    });
    expect(unknown.status).toBe(404);
  });

  it('replaces service associations within the specialty and guards specialty changes', async () => {
    const userId = await provisionProfessionalUser();
    const created = await http<{ data: { professionalId: string } }>('POST', '/api/v1/professionals', {
      token: adminToken,
      body: { userId, specialtyId: ids.generalMedicine, displayName: `IT Dra. ${runId}`, licenseNumber: `IT-${runId}-E` },
    });
    const professionalId = created.body.data.professionalId;

    const assigned = await http<{ data: { serviceIds: string[]; version: number } }>('PUT', `/api/v1/professionals/${professionalId}/services`, {
      token: adminToken,
      body: { serviceIds: [ids.generalConsultation] },
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data).toEqual({ professionalId, serviceIds: [ids.generalConsultation], version: 2 });
    const changed = await events.waitFor(
      (message) => message.messageType === 'ProfessionalServicesChanged' && message.payload['professionalId'] === professionalId,
    );
    expect(changed.payload).toMatchObject({ serviceIds: [ids.generalConsultation], aggregateVersion: 2 });

    const mismatch = await http('PUT', `/api/v1/professionals/${professionalId}/services`, {
      token: adminToken,
      body: { serviceIds: [ids.generalConsultation, ids.pediatricConsultation] },
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toMatchObject({ code: 'SPECIALTY_MISMATCH' });

    const specialtyChange = await http('PATCH', `/api/v1/professionals/${professionalId}`, {
      token: adminToken,
      body: { specialtyId: ids.pediatrics },
    });
    expect(specialtyChange.status).toBe(409);
    expect(specialtyChange.body).toMatchObject({ code: 'SPECIALTY_CHANGE_CONFLICT' });

    // TenantUserDeactivated → the linked professional becomes inactive (no new bookings).
    const deactivated = userEvents.envelope({
      messageType: 'TenantUserDeactivated',
      tenantId: CLINIC_1,
      actor: ADMIN_1,
      payload: { userId, keycloakSubject: randomUUID(), aggregateVersion: 3 },
    });
    await userEvents.event('user.user.deactivated', deactivated);
    const update = await events.waitFor(
      (message) => message.messageType === 'ProfessionalUpdated' && message.payload['professionalId'] === professionalId,
    );
    expect(update.payload).toMatchObject({ status: 'inactive' });
  });
});

describe('ValidateBookingCatalogCommand (RF9 saga participant)', () => {
  const validate = (payload: Record<string, unknown>): Envelope =>
    booking.envelope({
      messageType: 'ValidateBookingCatalogCommand',
      tenantId: CLINIC_1,
      actor: RECEPTIONIST_1,
      sagaId: randomUUID(),
      stepId: 'catalog',
      replyTo: 'appointment-orchestrator',
      payload,
    });

  it('returns the authoritative duration and versions, or a business rejection', async () => {
    const ok = validate({ professionalId: ids.professional1, serviceId: ids.generalConsultation });
    await booking.command('catalog-service-management.booking.validate', ok);
    expect((await replyOf(ok)).payload).toMatchObject({ outcome: 'succeeded', result: { durationMinutes: 30 } });

    const notQualified = validate({ professionalId: ids.professional1, serviceId: ids.pediatricConsultation });
    await booking.command('catalog-service-management.booking.validate', notQualified);
    expect((await replyOf(notQualified)).payload).toMatchObject({ outcome: 'rejected', error: { code: 'PROFESSIONAL_NOT_QUALIFIED' } });

    const foreign = validate({ professionalId: ids.clinic2Professional, serviceId: ids.clinic2Service });
    await booking.command('catalog-service-management.booking.validate', foreign);
    expect((await replyOf(foreign)).payload).toMatchObject({ outcome: 'rejected', error: { code: 'RESOURCE_NOT_FOUND' } });
  });
});
