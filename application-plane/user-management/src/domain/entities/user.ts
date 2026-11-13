import { ConflictError } from '@medicitas/kernel';

/** Roles a clinic user may hold (platform_admin is never assignable from the application plane). */
export const CLINIC_ROLES = ['clinic_admin', 'receptionist', 'health_professional'] as const;
export type ClinicRole = (typeof CLINIC_ROLES)[number];

export const USER_STATUSES = ['provisioning', 'active', 'inactive', 'provisioning_failed'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Clinic user (RF2). Credentials live in Keycloak; this is the tenant/role mirror. */
export interface User {
  readonly id: string;
  readonly tenantId: string;
  readonly keycloakSubject: string | null;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: ClinicRole;
  readonly status: UserStatus;
  readonly provisioningSagaId: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deactivatedAt: Date | null;
}

export interface UserTransition {
  readonly user: User;
  readonly changed: boolean;
}

function invalid(message: string): ConflictError {
  return new ConflictError('INVALID_STATE_TRANSITION', message);
}

/** provisioning → active, linking the Keycloak subject (ActivateUserCommand). */
export function activateUser(user: User, keycloakSubject: string): UserTransition {
  if (user.status === 'active' && user.keycloakSubject === keycloakSubject) return { user, changed: false };
  if (user.status !== 'provisioning') throw invalid(`A ${user.status} user cannot be activated.`);
  return { user: { ...user, status: 'active', keycloakSubject, version: user.version + 1 }, changed: true };
}

/** provisioning → provisioning_failed (compensation; the row is kept and the e-mail is freed). */
export function cancelReservation(user: User): UserTransition {
  if (user.status === 'provisioning_failed') return { user, changed: false };
  if (user.status !== 'provisioning') throw invalid(`A ${user.status} user reservation cannot be cancelled.`);
  return { user: { ...user, status: 'provisioning_failed', version: user.version + 1 }, changed: true };
}

/** Role change of an active user (the last-clinic-admin invariant is enforced under a lock by the database). */
export function changeRole(user: User, role: ClinicRole): UserTransition {
  if (user.status !== 'active') throw invalid(`The role of a ${user.status} user cannot be changed.`);
  if (user.role === role) return { user, changed: false };
  return { user: { ...user, role, version: user.version + 1 }, changed: true };
}

/** active → inactive (logical delete). A clinic admin can never deactivate their own account. */
export function deactivateUser(user: User, actorSubject: string | null, now: Date): UserTransition {
  if (user.status === 'inactive') return { user, changed: false };
  if (user.status !== 'active') throw invalid(`A ${user.status} user cannot be deactivated.`);
  if (actorSubject !== null && user.keycloakSubject === actorSubject) {
    throw invalid('A clinic administrator cannot deactivate their own account.');
  }
  return { user: { ...user, status: 'inactive', deactivatedAt: now, version: user.version + 1 }, changed: true };
}
