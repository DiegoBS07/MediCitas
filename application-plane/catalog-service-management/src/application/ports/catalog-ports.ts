import type { ActorRole } from '@medicitas/messaging';
import type { CatalogService, CatalogStatus, Professional, Specialty } from '../../domain/entities/catalog.js';

export interface ListWindow<Cursor> {
  readonly limit: number;
  readonly after: Cursor | null;
}

/** Persistence port of the catalog (runs inside the caller's transaction, under tenant RLS). */
export interface CatalogRepository {
  insertSpecialty(id: string, name: string): Promise<Specialty>;
  findSpecialty(id: string): Promise<Specialty | null>;
  listSpecialties(window: ListWindow<readonly [string, string]>): Promise<readonly Specialty[]>;

  insertService(service: { readonly id: string; readonly specialtyId: string; readonly name: string; readonly durationMinutes: number }): Promise<CatalogService>;
  findService(id: string, options?: { readonly forUpdate?: boolean }): Promise<CatalogService | null>;
  findServices(ids: readonly string[]): Promise<readonly CatalogService[]>;
  saveService(service: CatalogService): Promise<CatalogService>;
  listServices(
    filter: { readonly status: CatalogStatus | null; readonly specialtyId: string | null },
    window: ListWindow<readonly [string, string]>,
  ): Promise<readonly CatalogService[]>;

  insertProfessional(professional: Omit<Professional, 'tenantId' | 'status' | 'version' | 'servicesVersion' | 'createdAt' | 'updatedAt'>): Promise<Professional>;
  findProfessional(id: string, options?: { readonly forUpdate?: boolean }): Promise<Professional | null>;
  findProfessionalByUser(userId: string, options?: { readonly forUpdate?: boolean }): Promise<Professional | null>;
  saveProfessional(professional: Professional): Promise<Professional>;
  /** Status/version only (allowed to the system role that reacts to user deactivation). */
  saveProfessionalStatus(professional: Professional): Promise<Professional>;
  listProfessionals(
    filter: { readonly status: CatalogStatus | null; readonly specialtyId: string | null; readonly serviceId: string | null },
    window: ListWindow<readonly [string, string]>,
  ): Promise<readonly Professional[]>;

  professionalServiceIds(professionalId: string): Promise<readonly string[]>;
  replaceProfessionalServices(professionalId: string, serviceIds: readonly string[]): Promise<void>;
  offers(professionalId: string, serviceId: string): Promise<boolean>;

  upsertTenantReplica(tenant: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly timezone: string;
    readonly version: number;
  }): Promise<void>;
}

/** Answer of user-management to GetTenantUserQuery (RF4 eligibility check). */
export interface DirectoryUser {
  readonly userId: string;
  readonly keycloakSubject: string | null;
  readonly role: string;
  readonly status: string;
}

/** Port over the correlated RabbitMQ query to user-management (3 s timeout → 503). */
export interface UserDirectory {
  getTenantUser(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly actor: { readonly subject: string; readonly roles: readonly ActorRole[] };
    readonly correlationId: string;
  }): Promise<DirectoryUser | null>;
}
