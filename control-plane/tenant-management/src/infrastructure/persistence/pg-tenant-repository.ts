import { pgErrorInfo, type DatabaseClient } from '@medicitas/kernel';
import { TransientMessageError } from '@medicitas/messaging';
import type { Tenant, TenantStatus } from '../../domain/entities/tenant.js';
import { tenantSlugTaken } from '../../domain/errors/tenant-errors.js';
import { invalidTimezone } from '../../domain/value-objects/tenant-values.js';
import type { NewTenant, TenantListQuery, TenantListRow, TenantRepository } from '../../application/ports/tenant-repository.js';

interface TenantRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly status: TenantStatus;
  readonly failure_reason_code: string | null;
  readonly onboarding_saga_id: string;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly activated_at: Date | null;
  readonly created_at_exact?: string;
}

const COLUMNS = `id, slug, name, timezone, status, failure_reason_code, onboarding_saga_id, version,
                 created_at, updated_at, activated_at`;

function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    timezone: row.timezone,
    status: row.status,
    failureReasonCode: row.failure_reason_code,
    onboardingSagaId: row.onboarding_saga_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
  };
}

/** PostgreSQL adapter (schema tenancy, table tenants). Runs inside the caller's transaction. */
export class PgTenantRepository implements TenantRepository {
  constructor(private readonly client: DatabaseClient) {}

  async findById(id: string, options: { readonly forUpdate?: boolean } = {}): Promise<Tenant | null> {
    const { rows } = await this.client.query<TenantRow>(
      `SELECT ${COLUMNS} FROM tenants WHERE id = $1${options.forUpdate === true ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] === undefined ? null : toTenant(rows[0]);
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    const { rows } = await this.client.query<TenantRow>(`SELECT ${COLUMNS} FROM tenants WHERE slug = $1`, [slug]);
    return rows[0] === undefined ? null : toTenant(rows[0]);
  }

  async findByOnboardingSaga(sagaId: string): Promise<Tenant | null> {
    const { rows } = await this.client.query<TenantRow>(`SELECT ${COLUMNS} FROM tenants WHERE onboarding_saga_id = $1`, [sagaId]);
    return rows[0] === undefined ? null : toTenant(rows[0]);
  }

  async insert(tenant: NewTenant): Promise<Tenant> {
    try {
      const { rows } = await this.client.query<TenantRow>(
        `INSERT INTO tenants (id, slug, name, timezone, onboarding_saga_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${COLUMNS}`,
        [tenant.id, tenant.slug, tenant.name, tenant.timezone, tenant.onboardingSagaId],
      );
      return toTenant(rows[0] as TenantRow);
    } catch (error) {
      const info = pgErrorInfo(error);
      if (info.constraint === 'tenants_slug_unique') throw tenantSlugTaken(tenant.slug);
      if (info.constraint === 'tenants_timezone_valid') throw invalidTimezone(tenant.timezone);
      if (info.constraint === 'tenants_onboarding_saga_unique') {
        // The same saga raced with itself (duplicate command, new messageId): retry finds the row.
        throw new TransientMessageError('SAGA_RACE', 'concurrent creation for the same onboarding saga');
      }
      throw error;
    }
  }

  async saveTransition(tenant: Tenant): Promise<void> {
    await this.client.query(
      `UPDATE tenants
       SET status = $2, failure_reason_code = $3, version = $4, activated_at = $5
       WHERE id = $1`,
      [tenant.id, tenant.status, tenant.failureReasonCode, tenant.version, tenant.activatedAt],
    );
  }

  async list(query: TenantListQuery): Promise<readonly TenantListRow[]> {
    const params: unknown[] = [query.status, query.limit];
    let keyset = '';
    if (query.after !== null) {
      params.push(query.after.createdAt, query.after.id);
      keyset = 'AND (created_at, id) > ($3::timestamptz, $4::uuid)';
    }
    const { rows } = await this.client.query<TenantRow>(
      `SELECT ${COLUMNS}, to_json(created_at) #>> '{}' AS created_at_exact
       FROM tenants
       WHERE ($1::text IS NULL OR status = $1) ${keyset}
       ORDER BY created_at, id
       LIMIT $2`,
      params,
    );
    return rows.map((row) => ({ tenant: toTenant(row), createdAtExact: row.created_at_exact ?? row.created_at.toISOString() }));
  }
}
