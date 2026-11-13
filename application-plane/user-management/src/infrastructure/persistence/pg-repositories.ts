import { ValidationError, pgErrorInfo, type DatabaseClient } from '@medicitas/kernel';
import type { NewPatientData, Patient } from '../../domain/entities/patient.js';
import type { User } from '../../domain/entities/user.js';
import { emailTaken, lastClinicAdmin, patientIdentificationTaken } from '../../domain/errors/user-errors.js';
import type {
  NewUser,
  PatientListQuery,
  PatientRepository,
  TenantReplica,
  TenantReplicaRepository,
  UserListQuery,
  UserRepository,
} from '../../application/ports/repositories.js';

interface UserRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly keycloak_subject: string | null;
  readonly email: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly role: User['role'];
  readonly status: User['status'];
  readonly provisioning_saga_id: string | null;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly deactivated_at: Date | null;
}

const USER_COLUMNS = `id, tenant_id, keycloak_subject, email, first_name, last_name, role, status,
                      provisioning_saga_id, version, created_at, updated_at, deactivated_at`;

const toUser = (row: UserRow): User => ({
  id: row.id,
  tenantId: row.tenant_id,
  keycloakSubject: row.keycloak_subject,
  email: row.email,
  firstName: row.first_name,
  lastName: row.last_name,
  role: row.role,
  status: row.status,
  provisioningSagaId: row.provisioning_saga_id,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deactivatedAt: row.deactivated_at,
});

/** Escapes LIKE wildcards of a user-supplied prefix (queries stay parameterized). */
export function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

export class PgUserRepository implements UserRepository {
  constructor(private readonly client: DatabaseClient) {}

  async findById(id: string, options: { readonly forUpdate?: boolean } = {}): Promise<User | null> {
    const { rows } = await this.client.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1${options.forUpdate === true ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] === undefined ? null : toUser(rows[0]);
  }

  async findBySubject(subject: string): Promise<User | null> {
    const { rows } = await this.client.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE keycloak_subject = $1`, [subject]);
    return rows[0] === undefined ? null : toUser(rows[0]);
  }

  async insert(user: NewUser): Promise<User> {
    try {
      const { rows } = await this.client.query<UserRow>(
        `INSERT INTO users (id, tenant_id, keycloak_subject, email, first_name, last_name, role, status, provisioning_saga_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${USER_COLUMNS}`,
        [user.id, user.tenantId, user.keycloakSubject, user.email, user.firstName, user.lastName, user.role, user.status, user.provisioningSagaId],
      );
      return toUser(rows[0] as UserRow);
    } catch (error) {
      if (pgErrorInfo(error).constraint === 'users_email_unique') throw emailTaken();
      throw error;
    }
  }

  async save(user: User): Promise<User> {
    try {
      const { rows } = await this.client.query<UserRow>(
        `UPDATE users SET keycloak_subject = $2, role = $3, status = $4, version = $5, deactivated_at = $6
         WHERE id = $1
         RETURNING ${USER_COLUMNS}`,
        [user.id, user.keycloakSubject, user.role, user.status, user.version, user.deactivatedAt],
      );
      return toUser(rows[0] as UserRow);
    } catch (error) {
      if (pgErrorInfo(error).constraint === 'users_last_clinic_admin') throw lastClinicAdmin();
      throw error;
    }
  }

  async list(query: UserListQuery): Promise<readonly User[]> {
    const params: unknown[] = [query.role, query.status, query.search === null ? null : likePrefix(query.search.toLowerCase()), query.limit];
    let keyset = '';
    if (query.after !== null) {
      params.push(...query.after);
      keyset = 'AND (last_name, first_name, id) > ($5, $6, $7::uuid)';
    }
    const { rows } = await this.client.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users
       WHERE ($1::text IS NULL OR role = $1)
         AND ($2::text IS NULL OR status = $2)
         AND ($3::text IS NULL OR lower(last_name) LIKE $3 OR lower(first_name) LIKE $3 OR lower(email) LIKE $3)
         ${keyset}
       ORDER BY last_name, first_name, id
       LIMIT $4`,
      params,
    );
    return rows.map(toUser);
  }
}

interface PatientRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly identification_type: Patient['identificationType'];
  readonly identification_number: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly birth_date: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: string | null;
  readonly status: Patient['status'];
  readonly created_by_subject: string;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const PATIENT_COLUMNS = `id, tenant_id, identification_type, identification_number, first_name, last_name,
                         to_char(birth_date, 'YYYY-MM-DD') AS birth_date, email, phone, address, status,
                         created_by_subject, version, created_at, updated_at`;
/** Listing columns: contact data is never selected for lists (no audit needed, data minimization). */
const PATIENT_LIST_COLUMNS = `id, tenant_id, identification_type, identification_number, first_name, last_name,
                              to_char(birth_date, 'YYYY-MM-DD') AS birth_date, NULL::text AS email, NULL::text AS phone,
                              NULL::text AS address, status, created_by_subject, version, created_at, updated_at`;

const toPatient = (row: PatientRow): Patient => ({
  id: row.id,
  tenantId: row.tenant_id,
  identificationType: row.identification_type,
  identificationNumber: row.identification_number,
  firstName: row.first_name,
  lastName: row.last_name,
  birthDate: row.birth_date,
  contact: { email: row.email, phone: row.phone, address: row.address },
  status: row.status,
  createdBySubject: row.created_by_subject,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function mapPatientConstraint(error: unknown): never {
  const { constraint, sqlState } = pgErrorInfo(error);
  if (constraint === 'patients_identification_unique') throw patientIdentificationTaken(null);
  if (sqlState === '23514') {
    throw new ValidationError('The patient data is invalid.', [{ path: 'body', message: `rejected by rule ${constraint ?? 'check'}` }]);
  }
  throw error;
}

export class PgPatientRepository implements PatientRepository {
  constructor(private readonly client: DatabaseClient) {}

  async findById(id: string, options: { readonly forUpdate?: boolean } = {}): Promise<Patient | null> {
    const { rows } = await this.client.query<PatientRow>(
      `SELECT ${PATIENT_COLUMNS} FROM patients WHERE id = $1${options.forUpdate === true ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] === undefined ? null : toPatient(rows[0]);
  }

  async findByIdentification(type: string, number: string): Promise<Patient | null> {
    const { rows } = await this.client.query<PatientRow>(
      `SELECT ${PATIENT_LIST_COLUMNS} FROM patients WHERE identification_type = $1 AND identification_number = $2`,
      [type, number],
    );
    return rows[0] === undefined ? null : toPatient(rows[0]);
  }

  async insert(id: string, data: NewPatientData, createdBySubject: string): Promise<Patient> {
    try {
      const { rows } = await this.client.query<PatientRow>(
        `INSERT INTO patients (id, tenant_id, identification_type, identification_number, first_name, last_name,
                               birth_date, email, phone, address, created_by_subject)
         VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${PATIENT_COLUMNS}`,
        [
          id,
          data.identificationType,
          data.identificationNumber,
          data.firstName,
          data.lastName,
          data.birthDate,
          data.contact.email ?? null,
          data.contact.phone ?? null,
          data.contact.address ?? null,
          createdBySubject,
        ],
      );
      return toPatient(rows[0] as PatientRow);
    } catch (error) {
      return mapPatientConstraint(error);
    }
  }

  async save(patient: Patient): Promise<Patient> {
    try {
      const { rows } = await this.client.query<PatientRow>(
        `UPDATE patients
         SET first_name = $2, last_name = $3, birth_date = $4, email = $5, phone = $6, address = $7, status = $8, version = $9
         WHERE id = $1
         RETURNING ${PATIENT_COLUMNS}`,
        [
          patient.id,
          patient.firstName,
          patient.lastName,
          patient.birthDate,
          patient.contact.email,
          patient.contact.phone,
          patient.contact.address,
          patient.status,
          patient.version,
        ],
      );
      return toPatient(rows[0] as PatientRow);
    } catch (error) {
      return mapPatientConstraint(error);
    }
  }

  async list(query: PatientListQuery): Promise<readonly Patient[]> {
    const params: unknown[] = [query.search === null ? null : likePrefix(query.search.toLowerCase()), query.search === null ? null : likePrefix(query.search), query.limit];
    let keyset = '';
    if (query.after !== null) {
      params.push(...query.after);
      keyset = 'AND (lower(last_name), id) > ($4, $5::uuid)';
    }
    const { rows } = await this.client.query<PatientRow>(
      `SELECT ${PATIENT_LIST_COLUMNS} FROM patients
       WHERE ($1::text IS NULL OR lower(last_name) LIKE $1 OR lower(first_name) LIKE $1 OR identification_number LIKE $2)
         ${keyset}
       ORDER BY lower(last_name), id
       LIMIT $3`,
      params,
    );
    return rows.map(toPatient);
  }
}

export class PgTenantReplicaRepository implements TenantReplicaRepository {
  constructor(private readonly client: DatabaseClient) {}

  async upsert(tenant: TenantReplica): Promise<boolean> {
    const result = await this.client.query(
      `INSERT INTO tenants (id, slug, name, timezone, status, version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET slug = EXCLUDED.slug, name = EXCLUDED.name, timezone = EXCLUDED.timezone,
             status = EXCLUDED.status, version = EXCLUDED.version, replicated_at = clock_timestamp()
       WHERE tenants.version < EXCLUDED.version`,
      [tenant.id, tenant.slug, tenant.name, tenant.timezone, tenant.status, tenant.version],
    );
    return result.rowCount === 1;
  }

  async exists(id: string): Promise<boolean> {
    const { rowCount } = await this.client.query('SELECT 1 FROM tenants WHERE id = $1', [id]);
    return rowCount === 1;
  }
}
