import { ConflictError, NotFoundError } from '@medicitas/kernel';

export function tenantSlugTaken(slug: string): ConflictError {
  return new ConflictError('TENANT_SLUG_TAKEN', `The slug "${slug}" is already in use.`);
}

export function tenantNotFound(): NotFoundError {
  return new NotFoundError('tenant', 'Tenant not found.');
}
