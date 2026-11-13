import type { Patient } from '../entities/patient.js';
import type { ClinicRole, User } from '../entities/user.js';

/** Domain events of users and patients (messaging-contracts §8). Payloads never carry contact values. */
export const USER_EVENTS = {
  userActivated: { messageType: 'TenantUserActivated', routingKey: 'user.user.activated' },
  userRoleChanged: { messageType: 'TenantUserRoleChanged', routingKey: 'user.user.role-changed' },
  userDeactivated: { messageType: 'TenantUserDeactivated', routingKey: 'user.user.deactivated' },
  patientRegistered: { messageType: 'PatientRegistered', routingKey: 'user.patient.registered' },
  patientUpdated: { messageType: 'PatientUpdated', routingKey: 'user.patient.updated' },
  patientContactAccessed: { messageType: 'PatientContactAccessed', routingKey: 'user.patient.contact-accessed' },
} as const;

export const userActivatedPayload = (user: User) => ({
  userId: user.id,
  keycloakSubject: user.keycloakSubject,
  role: user.role,
  status: user.status,
  aggregateVersion: user.version,
});

export const userRoleChangedPayload = (user: User, previousRole: ClinicRole) => ({
  userId: user.id,
  previousRole,
  role: user.role,
  aggregateVersion: user.version,
});

export const userDeactivatedPayload = (user: User) => ({
  userId: user.id,
  keycloakSubject: user.keycloakSubject,
  aggregateVersion: user.version,
});

export const patientRegisteredPayload = (patient: Patient) => ({ patientId: patient.id, aggregateVersion: patient.version });

export const patientUpdatedPayload = (patient: Patient, changedFields: readonly string[]) => ({
  patientId: patient.id,
  changedFields: [...changedFields],
  aggregateVersion: patient.version,
});

export type ContactAction = 'read' | 'create' | 'update';

/** RF18 audit fact: who accessed a patient's contact data, when and with which result. */
export const patientContactAccessedPayload = (
  patientId: string,
  action: ContactAction,
  outcome: 'success' | 'denied',
  actor: { readonly subject: string; readonly role: string },
  accessedAt: Date,
) => ({
  patientId,
  action,
  outcome,
  actorSubject: actor.subject,
  actorRole: actor.role,
  accessedAt: accessedAt.toISOString(),
});
