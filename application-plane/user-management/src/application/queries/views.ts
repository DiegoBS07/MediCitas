import type { Patient } from '../../domain/entities/patient.js';
import type { User } from '../../domain/entities/user.js';

/** Public representations (api-contracts §3.3 and §3.8). */
export const toUserView = (user: User) => ({
  userId: user.id,
  keycloakSubject: user.keycloakSubject,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  role: user.role,
  status: user.status,
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
});

const patientBase = (patient: Patient) => ({
  patientId: patient.id,
  identificationType: patient.identificationType,
  identificationNumber: patient.identificationNumber,
  firstName: patient.firstName,
  lastName: patient.lastName,
  birthDate: patient.birthDate,
  status: patient.status,
  createdAt: patient.createdAt.toISOString(),
  updatedAt: patient.updatedAt.toISOString(),
});

/** Detail view, WITH contact data (only after an audited access). */
export const toPatientView = (patient: Patient) => ({ ...patientBase(patient), contact: { ...patient.contact } });

/** List view, WITHOUT contact data (lists are not audited). */
export const toPatientSummary = (patient: Patient) => patientBase(patient);
