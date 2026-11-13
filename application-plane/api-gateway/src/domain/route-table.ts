import type { Permission } from '@medicitas/identity';

/** Services reachable through the gateway (internal REST, decision D1). */
export const UPSTREAMS = [
  'tenant-management',
  'onboarding-orchestrator',
  'user-management',
  'user-management-orchestrator',
  'catalog-service-management',
  'scheduler-management',
  'appointment-orchestrator',
] as const;
export type Upstream = (typeof UPSTREAMS)[number];

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Coarse authorization at the edge:
 *  - a list of permissions (any of them grants access);
 *  - 'authenticated': any valid token;
 *  - 'clinic-user': any clinical role. Used ONLY for the clinical-note routes, so that the scheduler
 *    can audit denied attempts (RF15/RF18) instead of the gateway swallowing them.
 */
export type RouteAccess = readonly Permission[] | 'authenticated' | 'clinic-user';

export interface RouteDefinition {
  readonly method: HttpMethod;
  readonly path: string;
  readonly access: RouteAccess;
  /** null → served by the gateway itself. */
  readonly upstream: Upstream | null;
}

const route = (method: HttpMethod, path: string, access: RouteAccess, upstream: Upstream | null): RouteDefinition => ({
  method,
  path,
  access,
  upstream,
});

/**
 * Explicit routing table (api-contracts §2): no prefix guessing. Under /professionals/{id}, the
 * weekly-schedule and calendar-blocks sub-resources belong to the scheduler; /patients/{id}/appointments
 * belongs to the scheduler. A contract test compares this table with the documented catalog.
 */
export const ROUTES: readonly RouteDefinition[] = [
  route('GET', '/api/v1/me', 'authenticated', null),
  route('POST', '/api/v1/tenants', ['tenants:onboard'], 'onboarding-orchestrator'),
  route('GET', '/api/v1/tenant-onboardings/:operationId', ['tenants:read'], 'onboarding-orchestrator'),
  route('GET', '/api/v1/tenants', ['tenants:read'], 'tenant-management'),
  route('GET', '/api/v1/tenants/:tenantId', ['tenants:read'], 'tenant-management'),
  route('POST', '/api/v1/users', ['users:manage'], 'user-management-orchestrator'),
  route('PATCH', '/api/v1/users/:userId/role', ['users:manage'], 'user-management-orchestrator'),
  route('POST', '/api/v1/users/:userId/deactivate', ['users:manage'], 'user-management-orchestrator'),
  route('GET', '/api/v1/user-operations/:operationId', ['users:manage'], 'user-management-orchestrator'),
  route('GET', '/api/v1/users', ['users:manage'], 'user-management'),
  route('GET', '/api/v1/users/:userId', ['users:manage'], 'user-management'),
  route('POST', '/api/v1/specialties', ['catalog:manage'], 'catalog-service-management'),
  route('GET', '/api/v1/specialties', ['catalog:read'], 'catalog-service-management'),
  route('POST', '/api/v1/services', ['catalog:manage'], 'catalog-service-management'),
  route('GET', '/api/v1/services', ['catalog:read'], 'catalog-service-management'),
  route('GET', '/api/v1/services/:serviceId', ['catalog:read'], 'catalog-service-management'),
  route('PATCH', '/api/v1/services/:serviceId', ['catalog:manage'], 'catalog-service-management'),
  route('POST', '/api/v1/professionals', ['catalog:manage'], 'catalog-service-management'),
  route('GET', '/api/v1/professionals', ['catalog:read'], 'catalog-service-management'),
  route('GET', '/api/v1/professionals/:professionalId', ['catalog:read'], 'catalog-service-management'),
  route('PATCH', '/api/v1/professionals/:professionalId', ['catalog:manage'], 'catalog-service-management'),
  route('PUT', '/api/v1/professionals/:professionalId/services', ['catalog:manage'], 'catalog-service-management'),
  route('GET', '/api/v1/professionals/:professionalId/services', ['catalog:read'], 'catalog-service-management'),
  route('PUT', '/api/v1/professionals/:professionalId/weekly-schedule', ['schedule:manage', 'schedule:manage-own'], 'scheduler-management'),
  route('GET', '/api/v1/professionals/:professionalId/weekly-schedule', ['schedule:read'], 'scheduler-management'),
  route('POST', '/api/v1/professionals/:professionalId/calendar-blocks', ['schedule:manage', 'schedule:manage-own'], 'scheduler-management'),
  route('GET', '/api/v1/professionals/:professionalId/calendar-blocks', ['schedule:read'], 'scheduler-management'),
  route('DELETE', '/api/v1/professionals/:professionalId/calendar-blocks/:blockId', ['schedule:manage', 'schedule:manage-own'], 'scheduler-management'),
  route('GET', '/api/v1/schedule-conflicts', ['schedule:read'], 'scheduler-management'),
  route('GET', '/api/v1/availability', ['availability:read'], 'scheduler-management'),
  route('GET', '/api/v1/availability/search', ['availability:read'], 'scheduler-management'),
  route('POST', '/api/v1/appointments', ['appointments:book'], 'appointment-orchestrator'),
  route('GET', '/api/v1/appointment-operations/:operationId', ['appointments:book'], 'appointment-orchestrator'),
  route('GET', '/api/v1/appointments/:appointmentId', ['appointments:read'], 'scheduler-management'),
  route('POST', '/api/v1/appointments/:appointmentId/reschedule', ['appointments:book'], 'scheduler-management'),
  route('POST', '/api/v1/appointments/:appointmentId/cancel', ['appointments:book'], 'scheduler-management'),
  route('POST', '/api/v1/appointments/:appointmentId/outcome', ['appointments:outcome'], 'scheduler-management'),
  route('POST', '/api/v1/appointments/:appointmentId/clinical-note', 'clinic-user', 'scheduler-management'),
  route('GET', '/api/v1/appointments/:appointmentId/clinical-note', 'clinic-user', 'scheduler-management'),
  route('POST', '/api/v1/patients', ['patients:write'], 'user-management'),
  route('GET', '/api/v1/patients', ['patients:read'], 'user-management'),
  route('GET', '/api/v1/patients/:patientId', ['patients:read'], 'user-management'),
  route('PATCH', '/api/v1/patients/:patientId', ['patients:write'], 'user-management'),
  route('GET', '/api/v1/patients/:patientId/appointments', ['patient-history:read'], 'scheduler-management'),
  route('GET', '/api/v1/agenda', ['agenda:read', 'agenda:read-own'], 'scheduler-management'),
  route('GET', '/api/v1/reports/appointment-status-counts', ['reports:read'], 'scheduler-management'),
  route('GET', '/api/v1/audit-log', ['audit:read'], 'scheduler-management'),
];

interface CompiledRoute extends RouteDefinition {
  readonly pattern: RegExp;
}

const compiled: readonly CompiledRoute[] = ROUTES.map((definition) => ({
  ...definition,
  pattern: new RegExp(`^${definition.path.replace(/:[A-Za-z]+/g, '[^/]+')}/?$`),
}));

export type RouteMatch =
  | { readonly kind: 'found'; readonly route: RouteDefinition }
  | { readonly kind: 'method-not-allowed'; readonly allowed: readonly HttpMethod[] }
  | { readonly kind: 'not-found' };

/** Exact template match; a known path with another method is a 405, not a 404. */
export function matchRoute(method: string, path: string): RouteMatch {
  const candidates = compiled.filter((candidate) => candidate.pattern.test(path));
  if (candidates.length === 0) return { kind: 'not-found' };
  const found = candidates.find((candidate) => candidate.method === method);
  return found === undefined ? { kind: 'method-not-allowed', allowed: candidates.map((candidate) => candidate.method) } : { kind: 'found', route: found };
}
