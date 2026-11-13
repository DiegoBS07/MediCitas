import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { EXCHANGES, EnvelopeSchema, type Envelope } from '@medicitas/messaging';
import { MessageTap } from '../support/services.js';
import { GATEWAY, api, availability, book, codeOf, expectStatus, localDate, type ApiResult, type Appointment } from './support/api.js';
import { createPatient, createProfessional, seededToken, tokenOf, type TestProfessional } from './support/fixture.js';

/**
 * The documented contracts, verified on the running system: REST conventions (api-contracts §1:
 * problem+json, stable codes, correlation, idempotency, pagination, the three booking outcomes of
 * statement §6.2) and the messaging contract (messaging-contracts: versioned envelope, correlation
 * propagated from the HTTP request through the saga to the domain event, no personal data).
 */
const fixture = inject('acceptance');
const DATE = localDate(fixture.timezone, 12);

let professional: TestProfessional;
let token: string;
let patientId: string;
let slots: readonly string[];

function expectProblem(result: ApiResult<unknown>, status: number, code: string): void {
  expect([result.status, codeOf(result)]).toEqual([status, code]);
  expect(result.headers.get('content-type')).toMatch(/^application\/problem\+json/);
  const body = result.body as Record<string, unknown>;
  expect(body).toMatchObject({ status, code, correlationId: result.correlationId });
  expect(String(body['type'])).toMatch(/^urn:medicitas:problem:[a-z-]+$/);
  expect(typeof body['title']).toBe('string');
  expect(result.headers.get('x-correlation-id')).toBe(result.correlationId);
  const text = JSON.stringify(body);
  for (const leak of ['    at ', 'SELECT ', 'INSERT ', 'node_modules', 'password']) expect(text).not.toContain(leak);
}

beforeAll(async () => {
  token = await tokenOf(fixture.receptionists[0]);
  professional = await createProfessional(fixture, { name: 'Dr. Contrato' });
  patientId = await createPatient(token, 'Contrato');
  slots = expectStatus(await availability(token, professional.professionalId, fixture.serviceId, DATE), 200).body.data.slots.map((slot) => slot.startAt);
});

describe('REST error model (RFC 9457) and stable codes on every error class', () => {
  it('400, 401, 403, 404, 405, 413, 415 and 422 are problem+json with the request correlation id', async () => {
    const validation = await api('POST', '/api/v1/patients', { token, body: { firstName: 'Sin datos' } });
    expectProblem(validation, 400, 'VALIDATION_FAILED');
    expect((validation.body as { errors?: { path: string }[] }).errors?.length).toBeGreaterThan(0);
    expectProblem(await api('GET', '/api/v1/patients'), 401, 'AUTHENTICATION_REQUIRED');
    expectProblem(await api('GET', '/api/v1/audit-log', { token }), 403, 'FORBIDDEN');
    expectProblem(await api('GET', `/api/v1/patients/${randomUUID()}`, { token }), 404, 'RESOURCE_NOT_FOUND');
    expectProblem(await api('GET', '/api/v1/does-not-exist', { token }), 404, 'ROUTE_NOT_FOUND');
    const wrongMethod = await api('PUT', '/api/v1/patients', { token, body: {} });
    expectProblem(wrongMethod, 405, 'METHOD_NOT_ALLOWED');
    expect(wrongMethod.headers.get('allow')).toBe('POST, GET');
    expectProblem(await api('POST', '/api/v1/patients', { token, rawBody: JSON.stringify({ firstName: 'x'.repeat(70_000) }) }), 413, 'PAYLOAD_TOO_LARGE');
    expectProblem(await api('POST', '/api/v1/patients', { token, rawBody: 'firstName=x', headers: { 'Content-Type': 'text/plain' } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    expectProblem(await api('GET', `/api/v1/availability/search?serviceId=${fixture.serviceId}&from=${DATE}&to=${localDate(fixture.timezone, 40)}`, { token }), 422, 'DATE_RANGE_TOO_LARGE');
  });

  it('survives malformed input: broken JSON and malformed ids answer 400 and the services stay up', async () => {
    expectProblem(await api('POST', '/api/v1/patients', { token, rawBody: '{"firstName": ' }), 400, 'VALIDATION_FAILED');
    expectProblem(await api('GET', '/api/v1/appointments/not-a-uuid', { token }), 400, 'VALIDATION_FAILED');
    expectProblem(await api('GET', `/api/v1/availability?professionalId=${professional.professionalId}&serviceId=${fixture.serviceId}&date=31-12-2026`, { token }), 400, 'VALIDATION_FAILED');
    expect((await fetch(`${GATEWAY}/health/ready`)).status).toBe(200);
    expect((await api('GET', `/api/v1/patients/${patientId}`, { token })).status).toBe(200);
  });

  it('generates a correlation id when the client sends none or an invalid one', async () => {
    const result = await api('GET', '/api/v1/me', { token, headers: { 'X-Correlation-Id': 'not a uuid' }, correlationId: 'not a uuid' });
    expect(result.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('RF9 distinguishes its three outcomes (statement §6.2)', () => {
  it('granted → 201 + Location; slot already taken → 409; invalid request → 400/422/404', async () => {
    const granted = expectStatus(await book(token, { patientId, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: String(slots[0]) }), 201);
    expect(granted.headers.get('location')).toBe(`/api/v1/appointments/${granted.body.data.appointmentId}`);
    const otherPatient = await createPatient(token, 'Contrato');
    expectProblem(await book(token, { patientId: otherPatient, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: String(slots[0]) }), 409, 'SLOT_TAKEN');
    expectProblem(await api('POST', '/api/v1/appointments', { token, idempotencyKey: true, body: { professionalId: professional.professionalId } }), 400, 'VALIDATION_FAILED');
    expectProblem(await book(token, { patientId: otherPatient, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: `${DATE}T06:00:00-06:00` }), 422, 'OUTSIDE_WORKING_HOURS');
    expectProblem(await book(token, { patientId: randomUUID(), professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: String(slots[8]) }), 404, 'RESOURCE_NOT_FOUND');
  });
});

describe('idempotency (api-contracts §1.7)', () => {
  it('replays the original response for the same key and body, refuses a reused key with another body, requires the key', async () => {
    const key = `acc-idem-${randomUUID()}`;
    const input = { patientId, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: String(slots[4]) };
    const first = expectStatus(await book(token, input, key), 201);
    const replay = expectStatus(await book(token, input, key), 201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body).toEqual(first.body);
    expectProblem(await book(token, { ...input, startAt: String(slots[12]) }, key), 422, 'IDEMPOTENCY_KEY_REUSED');
    expectProblem(await api('POST', '/api/v1/appointments', { token, body: { patient: { id: patientId }, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: slots[12] } }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    expectProblem(await book(token, input, 'short'), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    // Only one appointment exists for that slot.
    const day = expectStatus(await api<{ data: { items: { startAt: string; status: string }[] } }>('GET', `/api/v1/agenda?date=${DATE}&professionalId=${professional.professionalId}`, { token }), 200);
    expect(day.body.data.items.filter((item) => item.startAt === first.body.data.startAt && item.status === 'booked')).toHaveLength(1);
  });

  it('honours an optional key on patient registration', async () => {
    const key = `acc-patient-${randomUUID()}`;
    const body = { identificationType: 'passport', identificationNumber: `IDEM-${randomUUID().slice(0, 8)}`, firstName: 'Idem', lastName: 'Potente', birthDate: '1990-01-01' };
    const first = expectStatus(await api<{ data: { patientId: string } }>('POST', '/api/v1/patients', { token, idempotencyKey: key, body }), 201);
    const replay = expectStatus(await api<{ data: { patientId: string } }>('POST', '/api/v1/patients', { token, idempotencyKey: key, body }), 201);
    expect(replay.body.data.patientId).toBe(first.body.data.patientId);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });
});

describe('keyset pagination (api-contracts §1.6)', () => {
  it('walks a list page by page without duplicates and validates limit and cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { data: { patientId: string }[]; page: { limit: number; nextCursor: string | null } } = expectStatus(
        await api<{ data: { patientId: string }[]; page: { limit: number; nextCursor: string | null } }>(
          'GET',
          `/api/v1/patients?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
          { token },
        ),
        200,
      ).body;
      expect(page.page.limit).toBe(2);
      seen.push(...page.data.map((patient) => patient.patientId));
      cursor = page.page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 50);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const limit of ['0', '101', 'abc']) expectProblem(await api('GET', `/api/v1/patients?limit=${limit}`, { token }), 400, 'VALIDATION_FAILED');
    expectProblem(await api('GET', '/api/v1/patients?cursor=%%%invalid', { token }), 400, 'VALIDATION_FAILED');
  });
});

describe('messaging contract on the live broker', () => {
  let tap: MessageTap;
  beforeAll(async () => {
    tap = await MessageTap.open([{ exchange: EXCHANGES.events, routingKey: 'scheduler.appointment.created' }]);
  });
  afterAll(async () => {
    await tap.close();
  });

  it('AppointmentCreated is a v1 envelope of the run tenant, carries the HTTP correlation id and no personal data', async () => {
    const correlationId = randomUUID();
    const booked = expectStatus(
      await api<{ data: Appointment }>('POST', '/api/v1/appointments', {
        token,
        idempotencyKey: true,
        correlationId,
        body: { patient: { id: patientId }, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt: slots[16] },
      }),
      201,
    ).body.data;
    const event = await tap.waitFor((message: Envelope) => message.payload['appointmentId'] === booked.appointmentId, 15_000);
    expect(EnvelopeSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({ messageType: 'AppointmentCreated', messageVersion: 1, producer: 'scheduler-management', tenantId: fixture.tenantId, correlationId });
    expect(event.causationId).not.toBeNull();
    expect(event.actor).toMatchObject({ subject: fixture.receptionists[0].subject });
    expect(event.payload).toMatchObject({ appointmentId: booked.appointmentId, professionalId: professional.professionalId, patientId });
    expect(JSON.stringify(event)).not.toContain('Contrato'); // the patient's name never travels in events
  });

  it('a platform-admin token cannot reach clinic data even though it is valid (no tenant in the token)', async () => {
    expectProblem(await api('GET', `/api/v1/appointments/${randomUUID()}`, { token: await seededToken('platformAdmin') }), 403, 'FORBIDDEN');
  });
});
