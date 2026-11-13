import type { Tenant, TenantStatus } from '../../domain/entities/tenant.js';

export interface NewTenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly onboardingSagaId: string;
}

export interface TenantListQuery {
  readonly status: TenantStatus | null;
  readonly limit: number;
  /** Keyset position: (createdAt exact text, id) of the last row of the previous page. */
  readonly after: { readonly createdAt: string; readonly id: string } | null;
}

export interface TenantListRow {
  readonly tenant: Tenant;
  /** Exact timestamptz text (microseconds) used for the next cursor. */
  readonly createdAtExact: string;
}

/** Persistence port of the tenant aggregate. Implementations work inside the caller's transaction. */
export interface TenantRepository {
  findById(id: string, options?: { readonly forUpdate?: boolean }): Promise<Tenant | null>;
  findBySlug(slug: string): Promise<Tenant | null>;
  findByOnboardingSaga(sagaId: string): Promise<Tenant | null>;
  /** Inserts a provisioning tenant. Throws TENANT_SLUG_TAKEN / INVALID_TIMEZONE on constraint violations. */
  insert(tenant: NewTenant): Promise<Tenant>;
  /** Persists a lifecycle transition (status, failure reason, version, activation). */
  saveTransition(tenant: Tenant): Promise<void>;
  list(query: TenantListQuery): Promise<readonly TenantListRow[]>;
}
