import { describe, expect, it } from 'vitest';
import { AuthenticationError, AuthorizationError } from '@medicitas/kernel';
import { buildTenantContext, requirePermission, requireTenant, type VerifiedClaims } from '../src/index.js';

const TENANT = '10000000-0000-4000-8000-000000000001';
const SUBJECT = '30000000-0000-4000-8000-000000010002';
const CORRELATION = '4b8a6f0e-2f8e-4b8e-9a51-0f8d0f3c2a11';

function claims(overrides: Partial<Record<keyof VerifiedClaims, unknown>> = {}): VerifiedClaims {
  return {
    typ: 'Bearer',
    sub: SUBJECT,
    exp: Math.floor(Date.now() / 1000) + 300,
    tenant_id: TENANT,
    realm_access: { roles: ['receptionist', 'offline_access', 'default-roles-medicitas'] },
    ...overrides,
  };
}

function expectTokenInvalid(input: VerifiedClaims): void {
  try {
    buildTenantContext(input, CORRELATION);
    expect.unreachable('the claims should have been rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).code).toBe('TOKEN_INVALID');
  }
}

describe('buildTenantContext (architecture overview §4.1)', () => {
  it('builds a frozen tenant context for a clinical role, ignoring non-MediCitas roles', () => {
    const context = buildTenantContext(claims(), CORRELATION);
    expect(context.kind).toBe('tenant');
    expect(context.tenantId).toBe(TENANT);
    expect(context.subject).toBe(SUBJECT);
    expect(context.role).toBe('receptionist');
    expect(context.permissions.has('appointments:book')).toBe(true);
    expect(context.permissions.has('audit:read')).toBe(false);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it('builds a platform context without tenant for platform_admin', () => {
    const context = buildTenantContext(
      claims({ tenant_id: undefined, realm_access: { roles: ['platform_admin'] } }),
      CORRELATION,
    );
    expect(context.kind).toBe('platform');
    expect(context.tenantId).toBeNull();
    expect([...context.permissions].sort()).toEqual(['tenants:onboard', 'tenants:read']);
  });

  it('rejects a clinical role without tenant_id', () => expectTokenInvalid(claims({ tenant_id: undefined })));
  it('rejects a malformed tenant_id', () => expectTokenInvalid(claims({ tenant_id: 'clinic-1' })));
  it('rejects a platform admin that carries a tenant', () =>
    expectTokenInvalid(claims({ realm_access: { roles: ['platform_admin'] } })));
  it('rejects tokens with two MediCitas roles', () =>
    expectTokenInvalid(claims({ realm_access: { roles: ['receptionist', 'clinic_admin'] } })));
  it('rejects tokens without any MediCitas role', () =>
    expectTokenInvalid(claims({ realm_access: { roles: ['offline_access'] } })));
  it('rejects non-access tokens (ID/refresh tokens)', () => expectTokenInvalid(claims({ typ: 'ID' })));
  it('rejects a non-UUID subject', () => expectTokenInvalid(claims({ sub: 'admin' })));
  it('rejects a token without expiry', () => expectTokenInvalid(claims({ exp: undefined })));
});

describe('authorization helpers', () => {
  it('requirePermission throws 403 FORBIDDEN when the role lacks the permission', () => {
    const professional = buildTenantContext(claims({ realm_access: { roles: ['health_professional'] } }), CORRELATION);
    expect(() => requirePermission(professional, 'appointments:book')).toThrow(AuthorizationError);
    expect(() => requirePermission(professional, 'appointments:outcome')).not.toThrow();
  });

  it('requireTenant rejects the platform administrator on application-plane operations', () => {
    const platform = buildTenantContext(
      claims({ tenant_id: undefined, realm_access: { roles: ['platform_admin'] } }),
      CORRELATION,
    );
    expect(() => requireTenant(platform)).toThrow(AuthorizationError);
  });
});
