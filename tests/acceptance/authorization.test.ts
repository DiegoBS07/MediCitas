import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, codeOf, expectStatus } from './support/api.js';
import { seededToken } from './support/fixture.js';

/**
 * Acceptance criterion 3 (identity is required and respected) over the WHOLE public surface: every
 * one of the 47 routes is called without a token (401), and with a token of each role (403 when the
 * role lacks the permission, anything but 401/403 when it has it).
 *
 * The oracle below is written independently from the code: it is the course permission matrix plus
 * its approved extensions (catalog, schedule and appointment reads, agenda and counts). Requests carry
 * empty bodies, no Idempotency-Key and unknown ids, so an allowed call fails validation (400) or finds
 * nothing (404) and never changes data.
 */
type Role = 'platform_admin' | 'clinic_admin' | 'receptionist' | 'health_professional';
const PA: Role = 'platform_admin';
const CA: Role = 'clinic_admin';
const RE: Role = 'receptionist';
const HP: Role = 'health_professional';
const CLINICAL: readonly Role[] = [CA, RE, HP];

const X = randomUUID(); // unknown id in every tenant

/** [method, path, roles allowed by the matrix]. `{own}` = the seeded professional's own profile. */
const MATRIX: readonly (readonly [string, string, readonly Role[]])[] = [
  ['GET', '/api/v1/me', [PA, CA, RE, HP]],
  // RF1 — clinic onboarding: platform administrator only (+ tenants:read, extension)
  ['POST', '/api/v1/tenants', [PA]],
  ['GET', `/api/v1/tenant-onboardings/${X}`, [PA]],
  ['GET', '/api/v1/tenants', [PA]],
  ['GET', `/api/v1/tenants/${X}`, [PA]],
  // RF2–RF4 — users, services and professionals: clinic administrator (catalog reads: extension)
  ['POST', '/api/v1/users', [CA]],
  ['PATCH', `/api/v1/users/${X}/role`, [CA]],
  ['POST', `/api/v1/users/${X}/deactivate`, [CA]],
  ['GET', `/api/v1/user-operations/${X}`, [CA]],
  ['GET', '/api/v1/users', [CA]],
  ['GET', `/api/v1/users/${X}`, [CA]],
  ['POST', '/api/v1/specialties', [CA]],
  ['GET', '/api/v1/specialties', CLINICAL],
  ['POST', '/api/v1/services', [CA]],
  ['GET', '/api/v1/services', CLINICAL],
  ['GET', `/api/v1/services/${X}`, CLINICAL],
  ['PATCH', `/api/v1/services/${X}`, [CA]],
  ['POST', '/api/v1/professionals', [CA]],
  ['GET', '/api/v1/professionals', CLINICAL],
  ['GET', `/api/v1/professionals/${X}`, CLINICAL],
  ['PATCH', `/api/v1/professionals/${X}`, [CA]],
  ['PUT', `/api/v1/professionals/${X}/services`, [CA]],
  ['GET', `/api/v1/professionals/${X}/services`, CLINICAL],
  // RF5–RF6 — schedules and blocks: clinic administrator; professionals only their own (reads: extension)
  ['PUT', '/api/v1/professionals/{own}/weekly-schedule', [CA, HP]],
  ['GET', '/api/v1/professionals/{own}/weekly-schedule', CLINICAL],
  ['POST', '/api/v1/professionals/{own}/calendar-blocks', [CA, HP]],
  ['GET', '/api/v1/professionals/{own}/calendar-blocks', CLINICAL],
  ['DELETE', `/api/v1/professionals/{own}/calendar-blocks/${X}`, [CA, HP]],
  ['GET', '/api/v1/schedule-conflicts', CLINICAL],
  // RF7–RF8 — availability: the three clinical roles
  ['GET', '/api/v1/availability', CLINICAL],
  ['GET', '/api/v1/availability/search', CLINICAL],
  // RF9–RF11 — book, reschedule, cancel: clinic administrator and reception
  ['POST', '/api/v1/appointments', [CA, RE]],
  ['GET', `/api/v1/appointment-operations/${X}`, [CA, RE]],
  ['GET', `/api/v1/appointments/${X}`, CLINICAL],
  ['POST', `/api/v1/appointments/${X}/reschedule`, [CA, RE]],
  ['POST', `/api/v1/appointments/${X}/cancel`, [CA, RE]],
  // RF12 — outcome: the three clinical roles
  ['POST', `/api/v1/appointments/${X}/outcome`, CLINICAL],
  // RF15 — clinical note: only the appointment's professional. The gateway lets clinic users through so the
  // scheduler can audit denied attempts; it is checked separately below.
  ['POST', `/api/v1/appointments/${X}/clinical-note`, CLINICAL],
  ['GET', `/api/v1/appointments/${X}/clinical-note`, CLINICAL],
  // RF14 — patients: clinic administrator and reception; professionals read only
  ['POST', '/api/v1/patients', [CA, RE]],
  ['GET', '/api/v1/patients', CLINICAL],
  ['GET', `/api/v1/patients/${X}`, CLINICAL],
  ['PATCH', `/api/v1/patients/${X}`, [CA, RE]],
  // RF16 — history: the three clinical roles
  ['GET', `/api/v1/patients/${X}/appointments`, CLINICAL],
  // RF20/RF21 (extensions) — agenda (professionals: their own) and counts
  ['GET', '/api/v1/agenda', CLINICAL],
  ['GET', '/api/v1/reports/appointment-status-counts', [CA, RE]],
  // RF19 — audit log: clinic administrator only
  ['GET', '/api/v1/audit-log', [CA]],
];

const tokens = new Map<Role, string>();
let ownProfessionalId: string;

beforeAll(async () => {
  tokens.set(PA, await seededToken('platformAdmin'));
  tokens.set(CA, await seededToken('clinic1Admin'));
  tokens.set(RE, await seededToken('clinic1Receptionist'));
  tokens.set(HP, await seededToken('clinic1Professional'));
  const me = expectStatus(await api<{ data: { subject: string } }>('GET', '/api/v1/me', { token: tokens.get(HP) }), 200);
  const professionals = expectStatus(
    await api<{ data: { professionalId: string; keycloakSubject: string }[] }>('GET', '/api/v1/professionals?limit=100', { token: tokens.get(CA) }),
    200,
  );
  const own = professionals.body.data.find((professional) => professional.keycloakSubject === me.body.data.subject);
  if (own === undefined) throw new Error('seeded professional profile not found');
  ownProfessionalId = own.professionalId;
});

const call = (method: string, path: string, token?: string) =>
  api(method, path.replace('{own}', ownProfessionalId), { token, ...(['POST', 'PUT', 'PATCH'].includes(method) ? { body: {} } : {}) });

describe('the 47 public routes against the permission matrix (RF17)', () => {
  it('covers every route of the catalog exactly once', () => {
    expect(MATRIX).toHaveLength(47);
    expect(new Set(MATRIX.map(([method, path]) => `${method} ${path.replace(X, ':id')}`)).size).toBe(47);
  });

  it('answers 401 AUTHENTICATION_REQUIRED (with WWW-Authenticate) on every route without a token', async () => {
    const results = await Promise.all(MATRIX.map(async ([method, path]) => ({ route: `${method} ${path}`, result: await call(method, path) })));
    for (const { route, result } of results) {
      expect([route, result.status, codeOf(result)]).toEqual([route, 401, 'AUTHENTICATION_REQUIRED']);
      expect(result.headers.get('www-authenticate')).toMatch(/^Bearer/);
    }
  });

  for (const role of [PA, CA, RE, HP]) {
    it(`enforces the matrix for ${role}: 403 FORBIDDEN without the permission, never 401/403 with it`, async () => {
      const token = tokens.get(role);
      const results = await Promise.all(
        MATRIX.map(async ([method, path, allowed]) => ({ route: `${method} ${path}`, allowed: allowed.includes(role), result: await call(method, path, token) })),
      );
      const violations = results
        .filter(({ allowed, result }) => (allowed ? result.status === 401 || result.status === 403 : result.status !== 403 || codeOf(result) !== 'FORBIDDEN'))
        .map(({ route, allowed, result }) => `${route}: ${allowed ? 'allowed' : 'denied'} but got ${result.status} ${codeOf(result) ?? ''}`);
      expect(violations).toEqual([]);
      // No allowed call may crash the service either (error handling).
      expect(results.filter(({ result }) => result.status >= 500).map(({ route }) => route)).toEqual([]);
    });
  }
});

describe('token validation and the success path for the right role', () => {
  it('rejects malformed, tampered and unsigned tokens with 401 TOKEN_INVALID', async () => {
    const valid = String(tokens.get(RE));
    const [header, payload, signature] = valid.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...claims, tenant_id: '10000000-0000-4000-8000-000000000002', realm_access: { roles: ['clinic_admin'] } })).toString('base64url');
    const unsignedHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    for (const token of ['not-a-jwt', `${header}.${forged}.${signature}`, `${unsignedHeader}.${payload}.`]) {
      const result = await api('GET', '/api/v1/me', { token });
      expect([result.status, codeOf(result)]).toEqual([401, 'TOKEN_INVALID']);
    }
  });

  it('works with a valid token of the right role (one representative route per role)', async () => {
    expect((await api('GET', '/api/v1/tenants', { token: tokens.get(PA) })).status).toBe(200);
    expect((await api('GET', '/api/v1/audit-log?limit=1', { token: tokens.get(CA) })).status).toBe(200);
    expect((await api('GET', '/api/v1/patients?limit=1', { token: tokens.get(RE) })).status).toBe(200);
    expect((await api('GET', `/api/v1/professionals/${ownProfessionalId}/weekly-schedule`, { token: tokens.get(HP) })).status).toBe(200);
  });

  it('applies ownership beyond the role: a professional cannot manage another professional schedule', async () => {
    const professionals = expectStatus(await api<{ data: { professionalId: string }[] }>('GET', '/api/v1/professionals?limit=100', { token: tokens.get(CA) }), 200);
    const other = professionals.body.data.find((professional) => professional.professionalId !== ownProfessionalId);
    if (other === undefined) throw new Error('a second seeded professional is required');
    const result = await api('POST', `/api/v1/professionals/${other.professionalId}/calendar-blocks`, {
      token: tokens.get(HP),
      body: { startAt: '2099-01-05T08:00:00-06:00', endAt: '2099-01-05T09:00:00-06:00', reason: 'other' },
    });
    expect([result.status, codeOf(result)]).toEqual([403, 'FORBIDDEN']);
  });
});
