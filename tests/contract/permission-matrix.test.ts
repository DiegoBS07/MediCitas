import { afterAll, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, ROLES } from '@medicitas/identity';
import { readonlyPool } from '../support/database.js';

const pool = readonlyPool('um', 'medicitas_user');
afterAll(async () => pool.end());

describe('contract: permission matrix in code == reference data in identity.role_permissions', () => {
  it('has exactly the same role → permission pairs', async () => {
    const { rows } = await pool.query<{ role_code: string; permission_code: string }>(
      'SELECT role_code, permission_code FROM identity.role_permissions ORDER BY 1, 2',
    );
    const fromDatabase = rows.map((row) => `${row.role_code}:${row.permission_code}`).sort();
    const fromCode = ROLES.flatMap((role) => ROLE_PERMISSIONS[role].map((permission) => `${role}:${permission}`)).sort();
    expect(fromDatabase).toEqual(fromCode);
  });
});
