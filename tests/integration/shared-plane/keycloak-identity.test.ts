import { afterAll, describe, expect, it } from 'vitest';
import { AuthenticationError, withTransaction } from '@medicitas/kernel';
import { createJwtVerifier } from '@medicitas/identity';
import { CLINIC_1, runtimePool } from '../../support/database.js';
import { env } from '../../support/env.js';
import { decodePayload, demoPassword, passwordGrant, provisionerToken, realmUrl } from '../../support/keycloak.js';

const CORRELATION = '4b8a6f0e-2f8e-4b8e-9a51-0f8d0f3c2a11';
const verifier = createJwtVerifier({
  // Tests run on the host, so keys are fetched through the public URL; services use the internal one.
  jwksUrl: `${realmUrl()}/protocol/openid-connect/certs`,
  issuer: realmUrl(),
  audience: 'medicitas-api',
});
const userPool = runtimePool('um', 'medicitas_user');
afterAll(async () => userPool.end());

async function expectInvalid(promise: Promise<unknown>, code: 'TOKEN_INVALID' | 'AUTHENTICATION_REQUIRED'): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AuthenticationError);
  expect((error as AuthenticationError).code).toBe(code);
}

describe('Keycloak realm (ADR-0005) and token validation (RF17)', () => {
  it('publishes the public issuer in discovery', async () => {
    const discovery = (await (await fetch(`${realmUrl()}/.well-known/openid-configuration`)).json()) as { issuer: string };
    expect(discovery.issuer).toBe(`${env('KEYCLOAK_PUBLIC_URL')}/realms/medicitas`);
  });

  it('validates a receptionist token against the JWKS and derives the clinic from the identity', async () => {
    const token = await passwordGrant('carlos.jimenez@sanjose.medicitas.test', demoPassword());
    const context = await verifier.verifyAuthorizationHeader(`Bearer ${token}`, CORRELATION);
    expect(context).toMatchObject({ kind: 'tenant', tenantId: CLINIC_1, role: 'receptionist' });
    expect(context.permissions.has('appointments:book')).toBe(true);
  });

  it('issues the platform administrator a token without tenant', async () => {
    const token = await passwordGrant('platform.admin@medicitas.test', env('MEDICITAS_PLATFORM_ADMIN_PASSWORD'));
    const context = await verifier.verifyToken(token, CORRELATION);
    expect(context.kind).toBe('platform');
    expect(context.tenantId).toBeNull();
  });

  it('every seeded clinic user maps to the same subject and tenant as identity.users', async () => {
    for (const tenantId of [CLINIC_1, '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003']) {
      const users = await withTransaction(
        userPool,
        { tenantId, actorSubject: null, dbRole: 'um_system', isolation: 'READ COMMITTED' },
        async (client) =>
          (await client.query<{ email: string; keycloak_subject: string; tenant_id: string; role: string }>(
            'SELECT email, keycloak_subject, tenant_id, role FROM users ORDER BY email',
          )).rows,
      );
      expect(users).toHaveLength(6);
      for (const user of users) {
        const payload = decodePayload(await passwordGrant(user.email, demoPassword()));
        expect(payload['sub']).toBe(user.keycloak_subject);
        expect(payload['tenant_id']).toBe(user.tenant_id);
        expect((payload['realm_access'] as { roles: string[] }).roles).toContain(user.role);
      }
    }
  });

  it('rejects missing, malformed, tampered and wrong-audience tokens with 401 semantics', async () => {
    const token = await passwordGrant('ana.mora@sanjose.medicitas.test', demoPassword());
    await expectInvalid(verifier.verifyAuthorizationHeader(undefined, CORRELATION), 'AUTHENTICATION_REQUIRED');
    await expectInvalid(verifier.verifyAuthorizationHeader('Basic abc', CORRELATION), 'TOKEN_INVALID');
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...decodePayload(token), tenant_id: '10000000-0000-4000-8000-000000000002' }),
    ).toString('base64url');
    await expectInvalid(verifier.verifyToken(`${header}.${forged}.${signature}`, CORRELATION), 'TOKEN_INVALID');
    await expectInvalid(verifier.verifyToken(`${header}.${payload}.${signature.slice(0, -4)}AAAA`, CORRELATION), 'TOKEN_INVALID');
    const otherAudience = createJwtVerifier({
      jwksUrl: `${realmUrl()}/protocol/openid-connect/certs`,
      issuer: realmUrl(),
      audience: 'another-api',
    });
    await expectInvalid(otherAudience.verifyToken(token, CORRELATION), 'TOKEN_INVALID');
    const otherIssuer = createJwtVerifier({
      jwksUrl: `${realmUrl()}/protocol/openid-connect/certs`,
      issuer: 'http://keycloak:8080/realms/medicitas',
      audience: 'medicitas-api',
    });
    await expectInvalid(otherIssuer.verifyToken(token, CORRELATION), 'TOKEN_INVALID');
  });

  it('a user cannot change their own tenant through the account API', async () => {
    const token = await passwordGrant('carlos.jimenez@sanjose.medicitas.test', demoPassword());
    const response = await fetch(`${realmUrl()}/account`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        username: 'carlos.jimenez@sanjose.medicitas.test',
        email: 'carlos.jimenez@sanjose.medicitas.test',
        firstName: 'Carlos',
        lastName: 'Jiménez',
        attributes: { tenant_id: ['10000000-0000-4000-8000-000000000002'] },
      }),
    });
    expect([400, 401, 403]).toContain(response.status);
    const after = decodePayload(await passwordGrant('carlos.jimenez@sanjose.medicitas.test', demoPassword()));
    expect(after['tenant_id']).toBe(CLINIC_1);
  });

  it('the provisioner service account can manage users of the realm but not the realm itself', async () => {
    const token = await provisionerToken();
    const adminBase = realmUrl().replace('/realms/', '/admin/realms/');
    const users = await fetch(`${adminBase}/users?username=ana.mora@sanjose.medicitas.test&exact=true`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(users.status).toBe(200);
    const [user] = (await users.json()) as { attributes?: Record<string, string[]> }[];
    expect(user?.attributes?.['tenant_id']).toEqual([CLINIC_1]);
    const realmUpdate = await fetch(adminBase, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ registrationAllowed: true }),
    });
    expect(realmUpdate.status).toBe(403);
  });
});
