import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES, permissionsOf } from '../src/index.js';

describe('permission matrix', () => {
  const can = (role: (typeof ROLES)[number], permission: (typeof PERMISSIONS)[number]): boolean =>
    permissionsOf([role]).has(permission);

  it('platform admin only onboards and reads tenants (no clinical data)', () => {
    expect(ROLE_PERMISSIONS.platform_admin).toEqual(['tenants:onboard', 'tenants:read']);
  });

  it.each([
    // [operation, platform, clinic admin, receptionist, professional]
    ['tenants:onboard', true, false, false, false],
    ['users:manage', false, true, false, false],
    ['catalog:manage', false, true, false, false],
    ['schedule:manage', false, true, false, false],
    ['schedule:manage-own', false, false, false, true],
    ['availability:read', false, true, true, true],
    ['appointments:book', false, true, true, false],
    ['appointments:outcome', false, true, true, true],
    ['patients:write', false, true, true, false],
    ['patients:read', false, true, true, true],
    ['clinical-notes:own', false, false, false, true],
    ['patient-history:read', false, true, true, true],
    ['audit:read', false, true, false, false],
  ] as const)('%s → platform=%s admin=%s reception=%s professional=%s', (permission, p, a, r, h) => {
    expect(can('platform_admin', permission)).toBe(p);
    expect(can('clinic_admin', permission)).toBe(a);
    expect(can('receptionist', permission)).toBe(r);
    expect(can('health_professional', permission)).toBe(h);
  });

  it('every permission is granted to at least one role and every grant is a known permission', () => {
    const granted = new Set(ROLES.flatMap((role) => ROLE_PERMISSIONS[role]));
    expect([...granted].sort()).toEqual([...PERMISSIONS].sort());
  });
});
