/**
 * Permission matrix. The same mapping is stored as reference data
 * in identity.role_permissions; a contract test asserts both are identical.
 */
export const ROLES = ['platform_admin', 'clinic_admin', 'receptionist', 'health_professional'] as const;
export type Role = (typeof ROLES)[number];

export const CLINICAL_ROLES: readonly Role[] = ['clinic_admin', 'receptionist', 'health_professional'];

export const PERMISSIONS = [
  'tenants:onboard',
  'tenants:read',
  'users:manage',
  'catalog:manage',
  'catalog:read',
  'schedule:manage',
  'schedule:manage-own',
  'schedule:read',
  'availability:read',
  'appointments:book',
  'appointments:outcome',
  'appointments:read',
  'patients:write',
  'patients:read',
  'clinical-notes:own',
  'patient-history:read',
  'audit:read',
  'agenda:read',
  'agenda:read-own',
  'reports:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  platform_admin: ['tenants:onboard', 'tenants:read'],
  clinic_admin: [
    'users:manage',
    'catalog:manage',
    'catalog:read',
    'schedule:manage',
    'schedule:read',
    'availability:read',
    'appointments:book',
    'appointments:outcome',
    'appointments:read',
    'patients:write',
    'patients:read',
    'patient-history:read',
    'audit:read',
    'agenda:read',
    'reports:read',
  ],
  receptionist: [
    'catalog:read',
    'schedule:read',
    'availability:read',
    'appointments:book',
    'appointments:outcome',
    'appointments:read',
    'patients:write',
    'patients:read',
    'patient-history:read',
    'agenda:read',
    'reports:read',
  ],
  health_professional: [
    'catalog:read',
    'schedule:manage-own',
    'schedule:read',
    'availability:read',
    'appointments:outcome',
    'appointments:read',
    'patients:read',
    'clinical-notes:own',
    'patient-history:read',
    'agenda:read-own',
  ],
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function permissionsOf(roles: readonly Role[]): ReadonlySet<Permission> {
  return new Set(roles.flatMap((role) => ROLE_PERMISSIONS[role]));
}
