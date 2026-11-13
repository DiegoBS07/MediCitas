import { describe, expect, it } from 'vitest';
import { activateUser, cancelReservation, changeRole, deactivateUser, type User } from '../../src/domain/entities/user.js';
import { applyPatientPatch, type Patient } from '../../src/domain/entities/patient.js';

const user: User = {
  id: '20000000-0000-4000-8000-0000000000aa',
  tenantId: '10000000-0000-4000-8000-000000000001',
  keycloakSubject: null,
  email: 'nuevo@clinic.test',
  firstName: 'Nuevo',
  lastName: 'Usuario',
  role: 'receptionist',
  status: 'provisioning',
  provisioningSagaId: null,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  deactivatedAt: null,
};
const subject = '30000000-0000-4000-8000-0000000000aa';

describe('user lifecycle (RF2)', () => {
  it('activates once, links the subject and is idempotent', () => {
    const first = activateUser(user, subject);
    expect(first).toMatchObject({ changed: true, user: { status: 'active', keycloakSubject: subject, version: 2 } });
    expect(activateUser(first.user, subject).changed).toBe(false);
    expect(() => activateUser(first.user, '30000000-0000-4000-8000-0000000000bb')).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
  });

  it('cancels only reservations', () => {
    expect(cancelReservation(user).user.status).toBe('provisioning_failed');
    const active = activateUser(user, subject).user;
    expect(() => cancelReservation(active)).toThrowError(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
  });

  it('changes roles of active users only and forbids self-deactivation', () => {
    const active = activateUser(user, subject).user;
    expect(changeRole(active, 'clinic_admin').user.role).toBe('clinic_admin');
    expect(changeRole(active, 'receptionist').changed).toBe(false);
    expect(() => changeRole(user, 'clinic_admin')).toThrowError(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
    expect(() => deactivateUser(active, subject, new Date())).toThrowError(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
    const inactive = deactivateUser(active, '30000000-0000-4000-8000-000000010001', new Date());
    expect(inactive.user).toMatchObject({ status: 'inactive' });
    expect(deactivateUser(inactive.user, null, new Date()).changed).toBe(false);
  });
});

describe('patient patch (RF14)', () => {
  const patient: Patient = {
    id: '50000000-0000-4000-8000-0000000000aa',
    tenantId: user.tenantId,
    identificationType: 'national_id',
    identificationNumber: '1-1111-1111',
    firstName: 'Luis',
    lastName: 'Rojas',
    birthDate: '1990-04-12',
    contact: { email: 'luis@example.test', phone: '+50688887777', address: null },
    status: 'active',
    createdBySubject: subject,
    version: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('reports changed field names (never values) and flags contact changes for auditing', () => {
    const result = applyPatientPatch(patient, { firstName: 'Luis', contact: { phone: '+50677776666' }, status: 'inactive' });
    expect(result.changedFields).toEqual(['status', 'contact.phone']);
    expect(result.contactChanged).toBe(true);
    expect(result.patient).toMatchObject({ version: 4, status: 'inactive', contact: { phone: '+50677776666', email: 'luis@example.test' } });
  });

  it('does not bump the version when nothing changes', () => {
    const result = applyPatientPatch(patient, { lastName: 'Rojas', contact: { address: null } });
    expect(result.changedFields).toEqual([]);
    expect(result.patient.version).toBe(3);
  });
});
