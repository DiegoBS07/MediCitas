import { AuthenticationError, AuthorizationError, isUuid } from '@medicitas/kernel';
import { isRole, permissionsOf, type Permission, type Role } from './permissions.js';

/**
 * Immutable security context of one request.
 * Built ONLY from a token whose signature, issuer, audience and expiry were already verified.
 */
export interface TenantContext {
  readonly kind: 'platform' | 'tenant';
  /** null if and only if kind === 'platform'. */
  readonly tenantId: string | null;
  readonly subject: string;
  readonly role: Role;
  readonly roles: readonly Role[];
  readonly permissions: ReadonlySet<Permission>;
  readonly correlationId: string;
  readonly tokenExpiresAt: Date;
}

/** Verified access-token claims relevant to MediCitas (Keycloak format). */
export interface VerifiedClaims {
  readonly sub?: unknown;
  readonly exp?: unknown;
  readonly typ?: unknown;
  readonly tenant_id?: unknown;
  readonly realm_access?: unknown;
}

function invalid(reason: string): AuthenticationError {
  return new AuthenticationError('TOKEN_INVALID', `Access token rejected: ${reason}.`);
}

function extractRealmRoles(realmAccess: unknown): readonly Role[] {
  if (typeof realmAccess !== 'object' || realmAccess === null) return [];
  const roles = (realmAccess as { roles?: unknown }).roles;
  if (!Array.isArray(roles)) return [];
  // Keycloak adds default roles (offline_access, uma_authorization, default-roles-*): ignored.
  return [...new Set(roles.filter(isRole))];
}

/**
 * Applies the claim rules of the token:
 * exactly one MediCitas role; platform_admin has no tenant; clinical roles have exactly one valid tenant UUID.
 */
export function buildTenantContext(claims: VerifiedClaims, correlationId: string): TenantContext {
  if (claims.typ !== 'Bearer') throw invalid('not an access token');
  if (!isUuid(claims.sub)) throw invalid('subject is not a UUID');
  if (typeof claims.exp !== 'number') throw invalid('missing expiry');

  const roles = extractRealmRoles(claims.realm_access);
  if (roles.length !== 1) throw invalid('a token must carry exactly one MediCitas role');
  const role = roles[0] as Role;

  const rawTenant = claims.tenant_id;
  let kind: TenantContext['kind'];
  let tenantId: string | null;
  if (role === 'platform_admin') {
    if (rawTenant !== undefined && rawTenant !== null && rawTenant !== '') {
      throw invalid('the platform administrator cannot belong to a tenant');
    }
    kind = 'platform';
    tenantId = null;
  } else {
    if (!isUuid(rawTenant)) throw invalid('clinical roles require a valid tenant_id claim');
    kind = 'tenant';
    tenantId = rawTenant;
  }

  return Object.freeze({
    kind,
    tenantId,
    subject: claims.sub,
    role,
    roles: Object.freeze([role]),
    permissions: permissionsOf([role]),
    correlationId,
    tokenExpiresAt: new Date(claims.exp * 1000),
  });
}

export function hasPermission(context: TenantContext, permission: Permission): boolean {
  return context.permissions.has(permission);
}

/** Throws 403 FORBIDDEN unless the context holds at least one of the permissions. */
export function requirePermission(context: TenantContext, ...anyOf: readonly Permission[]): void {
  if (!anyOf.some((permission) => context.permissions.has(permission))) {
    throw new AuthorizationError();
  }
}

/** Application-plane routes: a tenant context is mandatory (platform admin → 403). */
export function requireTenant(context: TenantContext): string {
  if (context.kind !== 'tenant' || context.tenantId === null) {
    throw new AuthorizationError('This operation requires a clinic user.');
  }
  return context.tenantId;
}
