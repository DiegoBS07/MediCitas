import type { NewPatientData, Patient, PatientStatus } from '../../domain/entities/patient.js';
import type { ClinicRole, User, UserStatus } from '../../domain/entities/user.js';

/** All repositories run inside the caller's transaction, under RLS for the context tenant. */
export interface NewUser {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: ClinicRole;
  readonly keycloakSubject: string | null;
  readonly status: 'provisioning' | 'active';
  readonly provisioningSagaId: string | null;
}

export interface UserListQuery {
  readonly role: ClinicRole | null;
  readonly status: UserStatus | null;
  readonly search: string | null;
  readonly limit: number;
  readonly after: readonly [string, string, string] | null;
}

export interface UserRepository {
  findById(id: string, options?: { readonly forUpdate?: boolean }): Promise<User | null>;
  findBySubject(subject: string): Promise<User | null>;
  /** Throws EMAIL_TAKEN when the e-mail is already registered (realm-wide uniqueness). */
  insert(user: NewUser): Promise<User>;
  /** Persists a transition; throws LAST_CLINIC_ADMIN when the database invariant rejects it. */
  save(user: User): Promise<User>;
  list(query: UserListQuery): Promise<readonly User[]>;
}

export interface PatientListQuery {
  readonly search: string | null;
  readonly limit: number;
  readonly after: readonly [string, string] | null;
}

export interface PatientRepository {
  findById(id: string, options?: { readonly forUpdate?: boolean }): Promise<Patient | null>;
  findByIdentification(type: string, number: string): Promise<Patient | null>;
  /** Throws PATIENT_IDENTIFICATION_TAKEN on a duplicate identification. */
  insert(id: string, data: NewPatientData, createdBySubject: string): Promise<Patient>;
  save(patient: Patient): Promise<Patient>;
  list(query: PatientListQuery): Promise<readonly Patient[]>;
}

export interface TenantReplica {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly status: 'active';
  readonly version: number;
}

export interface TenantReplicaRepository {
  /** Inserts or updates the replica only if `version` is newer than the stored one. */
  upsert(tenant: TenantReplica): Promise<boolean>;
  exists(id: string): Promise<boolean>;
}

export type { PatientStatus };
