import { pgErrorInfo, type DatabaseClient } from '@medicitas/kernel';
import type { CatalogService, CatalogStatus, Professional, Specialty } from '../../domain/entities/catalog.js';
import {
  professionalAlreadyRegistered,
  serviceNameTaken,
  specialtyChangeConflict,
  specialtyNameTaken,
  specialtyNotFound,
} from '../../domain/errors/catalog-errors.js';
import type { CatalogRepository, ListWindow } from '../../application/ports/catalog-ports.js';

interface SpecialtyRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly created_at: Date;
}
interface ServiceRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly specialty_id: string;
  readonly name: string;
  readonly duration_minutes: number;
  readonly status: CatalogStatus;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}
interface ProfessionalRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly keycloak_subject: string;
  readonly specialty_id: string;
  readonly display_name: string;
  readonly license_number: string;
  readonly status: CatalogStatus;
  readonly version: number;
  readonly services_version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const SERVICE_COLUMNS = 'id, tenant_id, specialty_id, name, duration_minutes, status, version, created_at, updated_at';
const PROFESSIONAL_COLUMNS = `id, tenant_id, user_id, keycloak_subject, specialty_id, display_name, license_number, status,
                              version, services_version, created_at, updated_at`;

const toSpecialty = (row: SpecialtyRow): Specialty => ({ id: row.id, tenantId: row.tenant_id, name: row.name, createdAt: row.created_at });
const toService = (row: ServiceRow): CatalogService => ({
  id: row.id,
  tenantId: row.tenant_id,
  specialtyId: row.specialty_id,
  name: row.name,
  durationMinutes: row.duration_minutes,
  status: row.status,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const toProfessional = (row: ProfessionalRow): Professional => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  keycloakSubject: row.keycloak_subject,
  specialtyId: row.specialty_id,
  displayName: row.display_name,
  licenseNumber: row.license_number,
  status: row.status,
  version: row.version,
  servicesVersion: row.services_version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function mapConstraint(error: unknown): never {
  switch (pgErrorInfo(error).constraint) {
    case 'specialties_name_unique':
      throw specialtyNameTaken();
    case 'services_name_unique':
      throw serviceNameTaken();
    case 'services_specialty_fk':
    case 'professionals_specialty_fk':
      throw specialtyNotFound();
    case 'professionals_user_unique':
    case 'professionals_subject_unique':
      throw professionalAlreadyRegistered('The user is already registered as a professional.');
    case 'professionals_license_unique':
      throw professionalAlreadyRegistered('The license number is already registered in this clinic.');
    case 'professionals_specialty_change_conflict':
      throw specialtyChangeConflict();
    default:
      throw error;
  }
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return mapConstraint(error);
  }
}

const lock = (options: { readonly forUpdate?: boolean }): string => (options.forUpdate === true ? ' FOR UPDATE' : '');

/** PostgreSQL adapter (schema catalog). tenant_id always comes from app.current_tenant_id(). */
export class PgCatalogRepository implements CatalogRepository {
  constructor(private readonly client: DatabaseClient) {}

  insertSpecialty(id: string, name: string): Promise<Specialty> {
    return guarded(async () => {
      const { rows } = await this.client.query<SpecialtyRow>(
        `INSERT INTO specialties (id, tenant_id, name) VALUES ($1, app.current_tenant_id(), $2)
         RETURNING id, tenant_id, name, created_at`,
        [id, name],
      );
      return toSpecialty(rows[0] as SpecialtyRow);
    });
  }

  async findSpecialty(id: string): Promise<Specialty | null> {
    const { rows } = await this.client.query<SpecialtyRow>('SELECT id, tenant_id, name, created_at FROM specialties WHERE id = $1', [id]);
    return rows[0] === undefined ? null : toSpecialty(rows[0]);
  }

  async listSpecialties(window: ListWindow<readonly [string, string]>): Promise<readonly Specialty[]> {
    const params: unknown[] = [window.limit];
    let keyset = '';
    if (window.after !== null) {
      params.push(...window.after);
      keyset = 'WHERE (lower(name), id) > ($2, $3::uuid)';
    }
    const { rows } = await this.client.query<SpecialtyRow>(
      `SELECT id, tenant_id, name, created_at FROM specialties ${keyset} ORDER BY lower(name), id LIMIT $1`,
      params,
    );
    return rows.map(toSpecialty);
  }

  insertService(service: { readonly id: string; readonly specialtyId: string; readonly name: string; readonly durationMinutes: number }): Promise<CatalogService> {
    return guarded(async () => {
      const { rows } = await this.client.query<ServiceRow>(
        `INSERT INTO services (id, tenant_id, specialty_id, name, duration_minutes)
         VALUES ($1, app.current_tenant_id(), $2, $3, $4) RETURNING ${SERVICE_COLUMNS}`,
        [service.id, service.specialtyId, service.name, service.durationMinutes],
      );
      return toService(rows[0] as ServiceRow);
    });
  }

  async findService(id: string, options: { readonly forUpdate?: boolean } = {}): Promise<CatalogService | null> {
    const { rows } = await this.client.query<ServiceRow>(`SELECT ${SERVICE_COLUMNS} FROM services WHERE id = $1${lock(options)}`, [id]);
    return rows[0] === undefined ? null : toService(rows[0]);
  }

  async findServices(ids: readonly string[]): Promise<readonly CatalogService[]> {
    const { rows } = await this.client.query<ServiceRow>(`SELECT ${SERVICE_COLUMNS} FROM services WHERE id = ANY($1::uuid[])`, [ids]);
    return rows.map(toService);
  }

  saveService(service: CatalogService): Promise<CatalogService> {
    return guarded(async () => {
      const { rows } = await this.client.query<ServiceRow>(
        `UPDATE services SET name = $2, duration_minutes = $3, status = $4, version = $5 WHERE id = $1 RETURNING ${SERVICE_COLUMNS}`,
        [service.id, service.name, service.durationMinutes, service.status, service.version],
      );
      return toService(rows[0] as ServiceRow);
    });
  }

  async listServices(
    filter: { readonly status: CatalogStatus | null; readonly specialtyId: string | null },
    window: ListWindow<readonly [string, string]>,
  ): Promise<readonly CatalogService[]> {
    const params: unknown[] = [filter.status, filter.specialtyId, window.limit];
    let keyset = '';
    if (window.after !== null) {
      params.push(...window.after);
      keyset = 'AND (lower(name), id) > ($4, $5::uuid)';
    }
    const { rows } = await this.client.query<ServiceRow>(
      `SELECT ${SERVICE_COLUMNS} FROM services
       WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR specialty_id = $2) ${keyset}
       ORDER BY lower(name), id LIMIT $3`,
      params,
    );
    return rows.map(toService);
  }

  insertProfessional(
    professional: Omit<Professional, 'tenantId' | 'status' | 'version' | 'servicesVersion' | 'createdAt' | 'updatedAt'>,
  ): Promise<Professional> {
    return guarded(async () => {
      const { rows } = await this.client.query<ProfessionalRow>(
        `INSERT INTO professionals (id, tenant_id, user_id, keycloak_subject, specialty_id, display_name, license_number)
         VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6) RETURNING ${PROFESSIONAL_COLUMNS}`,
        [
          professional.id,
          professional.userId,
          professional.keycloakSubject,
          professional.specialtyId,
          professional.displayName,
          professional.licenseNumber,
        ],
      );
      return toProfessional(rows[0] as ProfessionalRow);
    });
  }

  async findProfessional(id: string, options: { readonly forUpdate?: boolean } = {}): Promise<Professional | null> {
    const { rows } = await this.client.query<ProfessionalRow>(
      `SELECT ${PROFESSIONAL_COLUMNS} FROM professionals WHERE id = $1${lock(options)}`,
      [id],
    );
    return rows[0] === undefined ? null : toProfessional(rows[0]);
  }

  async findProfessionalByUser(userId: string, options: { readonly forUpdate?: boolean } = {}): Promise<Professional | null> {
    const { rows } = await this.client.query<ProfessionalRow>(
      `SELECT ${PROFESSIONAL_COLUMNS} FROM professionals WHERE user_id = $1${lock(options)}`,
      [userId],
    );
    return rows[0] === undefined ? null : toProfessional(rows[0]);
  }

  saveProfessional(professional: Professional): Promise<Professional> {
    return guarded(async () => {
      const { rows } = await this.client.query<ProfessionalRow>(
        `UPDATE professionals
         SET display_name = $2, license_number = $3, specialty_id = $4, status = $5, version = $6, services_version = $7
         WHERE id = $1 RETURNING ${PROFESSIONAL_COLUMNS}`,
        [
          professional.id,
          professional.displayName,
          professional.licenseNumber,
          professional.specialtyId,
          professional.status,
          professional.version,
          professional.servicesVersion,
        ],
      );
      return toProfessional(rows[0] as ProfessionalRow);
    });
  }

  /** Status-only update (catalog system role: reaction to TenantUserDeactivated). */
  async saveProfessionalStatus(professional: Professional): Promise<Professional> {
    const { rows } = await this.client.query<ProfessionalRow>(
      `UPDATE professionals SET status = $2, version = $3 WHERE id = $1 RETURNING ${PROFESSIONAL_COLUMNS}`,
      [professional.id, professional.status, professional.version],
    );
    return toProfessional(rows[0] as ProfessionalRow);
  }

  async listProfessionals(
    filter: { readonly status: CatalogStatus | null; readonly specialtyId: string | null; readonly serviceId: string | null },
    window: ListWindow<readonly [string, string]>,
  ): Promise<readonly Professional[]> {
    const params: unknown[] = [filter.status, filter.specialtyId, filter.serviceId, window.limit];
    let keyset = '';
    if (window.after !== null) {
      params.push(...window.after);
      keyset = 'AND (lower(p.display_name), p.id) > ($5, $6::uuid)';
    }
    const { rows } = await this.client.query<ProfessionalRow>(
      `SELECT ${PROFESSIONAL_COLUMNS.split(',').map((column) => `p.${column.trim()}`).join(', ')}
       FROM professionals p
       WHERE ($1::text IS NULL OR p.status = $1)
         AND ($2::uuid IS NULL OR p.specialty_id = $2)
         AND ($3::uuid IS NULL OR EXISTS (
               SELECT 1 FROM professional_services ps
               WHERE ps.tenant_id = p.tenant_id AND ps.professional_id = p.id AND ps.service_id = $3))
         ${keyset}
       ORDER BY lower(p.display_name), p.id LIMIT $4`,
      params,
    );
    return rows.map(toProfessional);
  }

  async professionalServiceIds(professionalId: string): Promise<readonly string[]> {
    const { rows } = await this.client.query<{ service_id: string }>(
      'SELECT service_id FROM professional_services WHERE professional_id = $1 ORDER BY service_id',
      [professionalId],
    );
    return rows.map((row) => row.service_id);
  }

  async replaceProfessionalServices(professionalId: string, serviceIds: readonly string[]): Promise<void> {
    await this.client.query('DELETE FROM professional_services WHERE professional_id = $1 AND NOT (service_id = ANY($2::uuid[]))', [
      professionalId,
      serviceIds,
    ]);
    await guarded(() =>
      this.client.query(
        `INSERT INTO professional_services (tenant_id, professional_id, service_id)
         SELECT app.current_tenant_id(), $1, unnest($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [professionalId, serviceIds],
      ),
    );
  }

  async offers(professionalId: string, serviceId: string): Promise<boolean> {
    const { rowCount } = await this.client.query(
      'SELECT 1 FROM professional_services WHERE professional_id = $1 AND service_id = $2',
      [professionalId, serviceId],
    );
    return rowCount === 1;
  }

  async upsertTenantReplica(tenant: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly timezone: string;
    readonly version: number;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO tenants (id, slug, name, timezone, status, version) VALUES ($1, $2, $3, $4, 'active', $5)
       ON CONFLICT (id) DO UPDATE
         SET slug = EXCLUDED.slug, name = EXCLUDED.name, timezone = EXCLUDED.timezone,
             version = EXCLUDED.version, replicated_at = clock_timestamp()
       WHERE tenants.version < EXCLUDED.version`,
      [tenant.id, tenant.slug, tenant.name, tenant.timezone, tenant.version],
    );
  }
}
