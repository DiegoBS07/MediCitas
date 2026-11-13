import type { Tenant, TenantStatus } from '../../domain/entities/tenant.js';
import { tenantNotFound } from '../../domain/errors/tenant-errors.js';
import type { TenantListRow, TenantRepository } from '../ports/tenant-repository.js';

/** Public representation (api-contracts §3.2). */
export interface TenantView {
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  readonly status: TenantStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activatedAt: string | null;
}

export function toTenantView(tenant: Tenant): TenantView {
  return {
    tenantId: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    timezone: tenant.timezone,
    status: tenant.status,
    createdAt: tenant.createdAt.toISOString(),
    updatedAt: tenant.updatedAt.toISOString(),
    activatedAt: tenant.activatedAt === null ? null : tenant.activatedAt.toISOString(),
  };
}

export async function getTenant(repository: TenantRepository, tenantId: string): Promise<TenantView> {
  const tenant = await repository.findById(tenantId);
  if (tenant === null) throw tenantNotFound();
  return toTenantView(tenant);
}

export function listTenants(
  repository: TenantRepository,
  query: Parameters<TenantRepository['list']>[0],
): Promise<readonly TenantListRow[]> {
  return repository.list({ ...query, limit: query.limit + 1 });
}
