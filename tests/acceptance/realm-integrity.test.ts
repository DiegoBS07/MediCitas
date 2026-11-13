import { describe, expect, it } from 'vitest';
import { SEEDED, clinicGroups } from './support/fixture.js';

/**
 * The versioned Keycloak realm (shared-plane/identity/keycloak/realm-medicitas.json) must survive
 * every test run: test cleanups may only remove identities the tests created. This check runs after
 * the integration suite in `npm test` and caught a Stage 4 cleanup that deleted a seeded clinic group.
 */
const SEEDED_CLINICS = {
  'clinica-san-jose': '10000000-0000-4000-8000-000000000001',
  'centro-medico-heredia': '10000000-0000-4000-8000-000000000002',
  'clinica-del-istmo': '10000000-0000-4000-8000-000000000003',
} as const;

describe('seeded realm integrity after the test runs', () => {
  it('keeps the three seeded clinic groups with their tenant_id and their seeded members', async () => {
    const groups = await clinicGroups();
    for (const [name, tenantId] of Object.entries(SEEDED_CLINICS)) {
      const group = groups.find((candidate) => candidate.name === name);
      expect(group, `/tenants/${name}`).toBeDefined();
      expect(group?.tenantId).toBe(tenantId);
      expect(group?.members.length).toBeGreaterThanOrEqual(6);
    }
    const sanJose = groups.find((group) => group.name === 'clinica-san-jose');
    expect(sanJose?.members).toEqual(expect.arrayContaining([SEEDED.clinic1Admin, SEEDED.clinic1Receptionist, SEEDED.clinic1Professional]));
    const heredia = groups.find((group) => group.name === 'centro-medico-heredia');
    expect(heredia?.members).toEqual(expect.arrayContaining([SEEDED.clinic2Admin, SEEDED.clinic2Receptionist]));
  });
});
