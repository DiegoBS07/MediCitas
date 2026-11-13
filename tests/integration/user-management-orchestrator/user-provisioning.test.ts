import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeycloakAdminClient } from '@medicitas/identity';
import type { RunningService } from '@medicitas/runtime';
import { startUserManagement } from '../../../application-plane/user-management/src/service.js';
import { startUserOrchestrator, type UserOrchestratorConfig } from '../../../application-plane/user-management-orchestrator/src/service.js';
import { CLINIC_1, ownerPool } from '../../support/database.js';
import { env } from '../../support/env.js';
import { passwordGrant } from '../../support/keycloak.js';
import { httpClient, serviceConfig } from '../../support/services.js';
import { tokenOf } from '../../support/tokens.js';

const runId = randomUUID().slice(0, 6);
const userOwner = ownerPool('um', 'medicitas_user');
const keycloak = new KeycloakAdminClient({
  baseUrl: env('KEYCLOAK_PUBLIC_URL'),
  realm: 'medicitas',
  clientId: 'medicitas-provisioner',
  clientSecret: env('MEDICITAS_PROVISIONER_CLIENT_SECRET'),
});
const createdEmails: string[] = [];

function orchestratorConfig(overrides: { readonly keycloakUrl?: string; readonly deadlineMs?: number } = {}): UserOrchestratorConfig {
  return {
    ...serviceConfig('umo', 'medicitas_user_orchestrator', 'user-management-orchestrator'),
    keycloakAdmin: {
      baseUrl: overrides.keycloakUrl ?? env('KEYCLOAK_PUBLIC_URL'),
      realm: 'medicitas',
      clientId: 'medicitas-provisioner',
      clientSecret: env('MEDICITAS_PROVISIONER_CLIENT_SECRET'),
      timeoutMs: 2_000,
      retryDelaysMs: [100, 200],
    },
    saga: {
      deadlineMs: overrides.deadlineMs ?? 60_000,
      syncWaitMs: 8_000,
      resendMs: 5_000,
      convergeWindowMs: 60_000,
      compensationWindowMs: 30_000,
      sweepIntervalMs: 250,
      localRetryMs: 500,
    },
  };
}

let users: RunningService;
let orchestrator: RunningService | undefined;
let http: ReturnType<typeof httpClient>;
let admin: string;

interface UserBody {
  readonly data: { readonly userId: string; readonly keycloakSubject: string; readonly role: string; readonly status: string };
  readonly code?: string;
}

const email = (label: string): string => {
  const value = `${label}.${runId}@it.medicitas.test`;
  createdEmails.push(value);
  return value;
};
const createUser = (body: Record<string, unknown>, key = `it-user-${randomUUID()}`, token = admin) =>
  http<UserBody>('POST', '/api/v1/users', { token, body, headers: { 'Idempotency-Key': key } });
const TEMP_PASSWORD = `It-Temp-${randomUUID()}`;

beforeAll(async () => {
  users = await startUserManagement(serviceConfig('um', 'medicitas_user', 'user-management'));
  orchestrator = await startUserOrchestrator(orchestratorConfig());
  http = httpClient(orchestrator.port);
  admin = await tokenOf('clinic1Admin');
});

afterAll(async () => {
  if (orchestrator !== undefined) await orchestrator.stop();
  await users.stop();
  for (const address of createdEmails) {
    const identity = await keycloak.findUserByUsername(address);
    if (identity !== null) await keycloak.deleteUser(identity.id);
  }
  await userOwner.query(`DELETE FROM identity.users WHERE email LIKE '%@it.medicitas.test'`);
  await userOwner.end();
});

describe('RF2 user provisioning saga (user-management + Keycloak)', () => {
  it('creates an active user with a Keycloak identity bound to the caller tenant, idempotently', async () => {
    const key = `it-user-${runId}-create`;
    const body = { email: email('recepcion'), firstName: 'Rita', lastName: 'Recepción', role: 'receptionist', temporaryPassword: TEMP_PASSWORD };
    const created = await createUser(body, key);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ role: 'receptionist', status: 'active' });
    expect(created.headers.get('location')).toBe(`/api/v1/users/${created.body.data.userId}`);

    const identity = await keycloak.findUserByUsername(body.email);
    expect(identity?.id).toBe(created.body.data.keycloakSubject);
    expect(identity?.attributes['tenant_id']).toEqual([CLINIC_1]);
    expect(await keycloak.realmRolesOf(created.body.data.keycloakSubject)).toContain('receptionist');
    // The password is temporary: Keycloak refuses direct login until it is changed (UPDATE_PASSWORD).
    await expect(passwordGrant(body.email, TEMP_PASSWORD)).rejects.toThrow();

    const replay = await createUser(body, key);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body.data.userId).toBe(created.body.data.userId);
    expect((await createUser({ ...body, firstName: 'Otra' }, key)).status).toBe(422);
  });

  it('changes the role (database first, then Keycloak) and deactivates the user everywhere', async () => {
    const created = await createUser({ email: email('rol'), firstName: 'Rolo', lastName: 'Cambio', role: 'receptionist', temporaryPassword: TEMP_PASSWORD });
    const userId = created.body.data.userId;
    const subject = created.body.data.keycloakSubject;

    const changed = await http<UserBody>('PATCH', `/api/v1/users/${userId}/role`, { token: admin, body: { role: 'health_professional' } });
    expect(changed.status).toBe(200);
    expect(changed.body.data.role).toBe('health_professional');
    const roles = await keycloak.realmRolesOf(subject);
    expect(roles).toContain('health_professional');
    expect(roles).not.toContain('receptionist');

    const deactivated = await http<UserBody>('POST', `/api/v1/users/${userId}/deactivate`, { token: admin });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.data.status).toBe('inactive');
    expect((await keycloak.getUser(subject))?.enabled).toBe(false);
    // api-contracts §3.3: an already inactive user → 409 INVALID_STATE_TRANSITION.
    const again = await http<{ code: string }>('POST', `/api/v1/users/${userId}/deactivate`, { token: admin });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE_TRANSITION']);
  });

  it('rejects taken e-mails, platform_admin, self-deactivation and demoting the last clinic admin', async () => {
    const taken = await createUser({ email: 'carlos.jimenez@sanjose.medicitas.test', firstName: 'X', lastName: 'Y', role: 'receptionist', temporaryPassword: TEMP_PASSWORD });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'EMAIL_TAKEN' });
    expect((await createUser({ email: email('pa'), firstName: 'P', lastName: 'A', role: 'platform_admin', temporaryPassword: TEMP_PASSWORD })).status).toBe(400);
    expect((await createUser({ email: email('short'), firstName: 'S', lastName: 'P', role: 'receptionist', temporaryPassword: 'short' })).status).toBe(400);
    expect((await http('POST', '/api/v1/users', { token: admin, body: { email: email('nokey'), firstName: 'N', lastName: 'K', role: 'receptionist', temporaryPassword: TEMP_PASSWORD } })).body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });

    const self = await http('POST', '/api/v1/users/20000000-0000-4000-8000-000000010001/deactivate', { token: admin });
    expect(self.status).toBe(409);
    expect(self.body).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    const lastAdmin = await http('PATCH', '/api/v1/users/20000000-0000-4000-8000-000000020001/role', {
      token: await tokenOf('clinic2Admin'),
      body: { role: 'receptionist' },
    });
    expect(lastAdmin.status).toBe(409);
    expect(lastAdmin.body).toMatchObject({ code: 'LAST_CLINIC_ADMIN' });
    expect((await keycloak.realmRolesOf('30000000-0000-4000-8000-000000020001'))).toContain('clinic_admin');

    expect((await http('PATCH', `/api/v1/users/${randomUUID()}/role`, { token: admin, body: { role: 'receptionist' } })).status).toBe(404);
    expect((await createUser({ email: email('forbidden'), firstName: 'F', lastName: 'B', role: 'receptionist', temporaryPassword: TEMP_PASSWORD }, undefined, await tokenOf('clinic1Receptionist'))).status).toBe(403);
  });

  it('compensates when the e-mail already belongs to a foreign Keycloak identity (never deleting it)', async () => {
    const address = email('foreign');
    const foreignId = await keycloak.createUser({ username: address, firstName: 'Foreign', lastName: 'Identity', attributes: {}, temporaryPassword: TEMP_PASSWORD });
    const response = await createUser({ email: address, firstName: 'F', lastName: 'I', role: 'receptionist', temporaryPassword: TEMP_PASSWORD });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'EMAIL_TAKEN' });
    expect((await keycloak.findUserByUsername(address))?.id).toBe(foreignId);
    const { rows } = await userOwner.query('SELECT status FROM identity.users WHERE email = $1', [address]);
    expect(rows).toEqual([{ status: 'provisioning_failed' }]);
  });

  it('compensates when Keycloak stays unavailable: no orphan identity, reservation marked failed', async () => {
    // Single orchestrator replica holding the password in memory (ADR-0012): stop the healthy one first.
    await orchestrator?.stop();
    orchestrator = await startUserOrchestrator(orchestratorConfig({ keycloakUrl: 'http://127.0.0.1:1', deadlineMs: 3_000 }));
    const client = httpClient(orchestrator.port);
    const address = email('down');
    const accepted = await client<{ data: { operationId: string }; code?: string }>('POST', '/api/v1/users', {
      token: admin,
      body: { email: address, firstName: 'K', lastName: 'Down', role: 'receptionist', temporaryPassword: TEMP_PASSWORD },
      headers: { 'Idempotency-Key': `it-user-${runId}-down` },
    });
    expect([202, 503]).toContain(accepted.status);
    if (accepted.status === 202) {
      await expect
        .poll(async () => (await client<{ data: { status: string; error: { code: string } | null } }>('GET', `/api/v1/user-operations/${accepted.body.data.operationId}`, { token: admin })).body.data, {
          timeout: 40_000,
          interval: 500,
        })
        .toMatchObject({ status: 'failed', error: { code: 'DEPENDENCY_UNAVAILABLE' } });
    } else {
      expect(accepted.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    }
    expect(await keycloak.findUserByUsername(address)).toBeNull();
    const { rows } = await userOwner.query('SELECT status FROM identity.users WHERE email = $1', [address]);
    expect(rows).toEqual([{ status: 'provisioning_failed' }]);
  }, 60_000);
});
