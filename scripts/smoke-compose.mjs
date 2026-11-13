#!/usr/bin/env node
// =============================================================================
// Smoke test of the running Docker Compose stack, black-box through the API gateway.
//
//   docker compose up -d --build --wait
//   node scripts/smoke-compose.mjs          (or: npm run smoke)
//
// Read-only: it never writes business data. It proves that the gateway is published, that it
// validates Keycloak tokens (issuer = public URL, keys via the internal name), that the permission
// matrix is enforced at the edge, and that every one of the seven upstream services is reachable by
// service name inside the network (an owning service answers 404 for an unknown operation; an
// unreachable one would surface as 503 DEPENDENCY_UNAVAILABLE).
//
// Reads .env (same file as docker compose). Never prints tokens or passwords.
// =============================================================================
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

if (existsSync('.env')) process.loadEnvFile('.env');

const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Missing ${name}: run "cp .env.example .env" first.`);
  return value;
};

const GATEWAY = `http://127.0.0.1:${process.env.GATEWAY_HOST_PORT ?? '8000'}`;
const KEYCLOAK = required('KEYCLOAK_PUBLIC_URL');
const SERVICE_GENERAL_CONSULTATION = '41000000-0000-4000-8000-000000010001';

async function token(username, password) {
  const response = await fetch(`${KEYCLOAK}/realms/medicitas/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'medicitas-cli', username, password }),
  });
  const body = await response.json();
  if (!response.ok || typeof body.access_token !== 'string') throw new Error(`token request for ${username} failed with HTTP ${response.status}`);
  return body.access_token;
}

async function call(method, path, bearer) {
  const headers = { 'X-Correlation-Id': randomUUID() };
  if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;
  const response = await fetch(`${GATEWAY}${path}`, { method, headers, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let body = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

const results = [];
async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - started });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
  }
}

function expectStatus(result, expected, label) {
  if (result.status !== expected) {
    const code = result.body !== null && typeof result.body === 'object' ? result.body.code : undefined;
    throw new Error(`${label}: expected HTTP ${expected}, got ${result.status}${code === undefined ? '' : ` (${code})`}`);
  }
}

const today = new Date();
const isoDate = (offsetDays) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const demoPassword = required('MEDICITAS_DEMO_USER_PASSWORD');
const [platformAdmin, clinicAdmin, receptionist] = await Promise.all([
  token('platform.admin@medicitas.test', required('MEDICITAS_PLATFORM_ADMIN_PASSWORD')),
  token('ana.mora@sanjose.medicitas.test', demoPassword),
  token('carlos.jimenez@sanjose.medicitas.test', demoPassword),
]);

await check('gateway liveness and readiness', async () => {
  expectStatus(await call('GET', '/health/live'), 200, 'live');
  const ready = await call('GET', '/health/ready');
  expectStatus(ready, 200, 'ready');
  return JSON.stringify(ready.body);
});

await check('401 without a token, 403 without the permission', async () => {
  expectStatus(await call('GET', '/api/v1/me'), 401, 'no token');
  expectStatus(await call('GET', '/api/v1/tenants', receptionist), 403, 'receptionist on /tenants');
  return '401 / 403';
});

await check('TenantContext from the token (GET /me)', async () => {
  const me = await call('GET', '/api/v1/me', receptionist);
  expectStatus(me, 200, '/me');
  return `tenant ${me.body.data.tenantId}, roles ${me.body.data.roles.join(',')}`;
});

await check('tenant-management: GET /tenants', async () => {
  const result = await call('GET', '/api/v1/tenants?limit=5', platformAdmin);
  expectStatus(result, 200, '/tenants');
  return `${result.body.data.length} tenants`;
});

await check('user-management: GET /users', async () => {
  const result = await call('GET', '/api/v1/users?limit=5', clinicAdmin);
  expectStatus(result, 200, '/users');
  return `${result.body.data.length} users`;
});

await check('catalog-service-management: GET /services', async () => {
  const result = await call('GET', '/api/v1/services?limit=5', receptionist);
  expectStatus(result, 200, '/services');
  return `${result.body.data.length} services`;
});

await check('scheduler-management: GET /availability/search (Redis cache)', async () => {
  const path = `/api/v1/availability/search?serviceId=${SERVICE_GENERAL_CONSULTATION}&from=${isoDate(7)}&to=${isoDate(13)}`;
  const result = await call('GET', path, receptionist);
  expectStatus(result, 200, '/availability/search');
  return `${result.body.data.professionals.length} professionals, X-Cache ${result.headers.get('x-cache') ?? '-'}`;
});

for (const [service, path, bearer] of [
  ['onboarding-orchestrator', `/api/v1/tenant-onboardings/${randomUUID()}`, platformAdmin],
  ['user-management-orchestrator', `/api/v1/user-operations/${randomUUID()}`, clinicAdmin],
  ['appointment-orchestrator', `/api/v1/appointment-operations/${randomUUID()}`, receptionist],
]) {
  await check(`${service}: reachable (unknown operation → 404)`, async () => {
    const result = await call('GET', path, bearer);
    expectStatus(result, 404, path.split('/').slice(0, 4).join('/'));
    return String(result.body.code);
  });
}

const width = Math.max(...results.map((result) => result.name.length));
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(width)}  ${String(result.ms).padStart(5)} ms  ${result.detail}`);
}
const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\nSmoke test passed (${results.length} checks).` : `\nSmoke test FAILED: ${failed} of ${results.length} checks.`);
process.exit(failed === 0 ? 0 : 1);
