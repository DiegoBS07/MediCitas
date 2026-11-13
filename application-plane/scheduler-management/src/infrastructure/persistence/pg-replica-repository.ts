import type { DatabaseClient } from '@medicitas/kernel';
import { TransientMessageError } from '@medicitas/messaging';

/**
 * Event-fed replicas: deliberate denormalizations of tenant/catalog facts. Every
 * upsert applies only a NEWER aggregateVersion, so duplicated or out-of-order events are harmless.
 */
export class PgReplicaRepository {
  constructor(private readonly client: DatabaseClient) {}

  async upsertTenant(tenant: { readonly id: string; readonly slug: string; readonly name: string; readonly timezone: string; readonly version: number }): Promise<void> {
    await this.client.query(
      `INSERT INTO tenants (id, slug, name, timezone, status, version) VALUES ($1, $2, $3, $4, 'active', $5)
       ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, timezone = EXCLUDED.timezone,
         version = EXCLUDED.version, replicated_at = clock_timestamp()
       WHERE tenants.version < EXCLUDED.version`,
      [tenant.id, tenant.slug, tenant.name, tenant.timezone, tenant.version],
    );
  }

  async upsertService(service: {
    readonly id: string;
    readonly specialtyId: string;
    readonly name: string;
    readonly durationMinutes: number;
    readonly status: string;
    readonly version: number;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO catalog_services (id, tenant_id, specialty_id, name, duration_minutes, status, version)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET specialty_id = EXCLUDED.specialty_id, name = EXCLUDED.name,
         duration_minutes = EXCLUDED.duration_minutes, status = EXCLUDED.status, version = EXCLUDED.version,
         replicated_at = clock_timestamp()
       WHERE catalog_services.version < EXCLUDED.version`,
      [service.id, service.specialtyId, service.name, service.durationMinutes, service.status, service.version],
    );
  }

  /** Returns true when the professional's status changed (its schedule version is then bumped). */
  async upsertProfessional(professional: {
    readonly id: string;
    readonly userId: string;
    readonly keycloakSubject: string;
    readonly displayName: string;
    readonly specialtyId: string;
    readonly status: string;
    readonly version: number;
  }): Promise<boolean> {
    const previous = await this.client.query<{ status: string }>('SELECT status FROM catalog_professionals WHERE id = $1', [professional.id]);
    const result = await this.client.query(
      `INSERT INTO catalog_professionals (id, tenant_id, user_id, keycloak_subject, display_name, specialty_id, status, version, services_version)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, 1)
       ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, keycloak_subject = EXCLUDED.keycloak_subject,
         display_name = EXCLUDED.display_name, specialty_id = EXCLUDED.specialty_id, status = EXCLUDED.status,
         version = EXCLUDED.version, replicated_at = clock_timestamp()
       WHERE catalog_professionals.version < EXCLUDED.version`,
      [
        professional.id,
        professional.userId,
        professional.keycloakSubject,
        professional.displayName,
        professional.specialtyId,
        professional.status,
        professional.version,
      ],
    );
    const before = previous.rows[0]?.status;
    const changed = result.rowCount === 1 && before !== undefined && before !== professional.status;
    if (changed) {
      await this.client.query(
        'UPDATE professional_agendas SET schedule_version = schedule_version + 1, updated_at = clock_timestamp() WHERE professional_id = $1',
        [professional.id],
      );
    }
    return changed;
  }

  /** Full replacement of a professional's services when services_version is newer. */
  async replaceProfessionalServices(professionalId: string, serviceIds: readonly string[], servicesVersion: number): Promise<boolean> {
    const { rows } = await this.client.query<{ services_version: number }>(
      'SELECT services_version FROM catalog_professionals WHERE id = $1 FOR UPDATE',
      [professionalId],
    );
    const current = rows[0];
    // The professional event has not been applied yet (independent consumers, no global order): retry later.
    if (current === undefined) throw new TransientMessageError('REPLICA_NOT_READY', 'professional replica not yet available');
    if (current.services_version >= servicesVersion) return false;
    await this.client.query(
      'DELETE FROM catalog_professional_services WHERE professional_id = $1 AND NOT (service_id = ANY($2::uuid[]))',
      [professionalId, serviceIds],
    );
    await this.client.query(
      `INSERT INTO catalog_professional_services (tenant_id, professional_id, service_id)
       SELECT app.current_tenant_id(), $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
      [professionalId, serviceIds],
    );
    await this.client.query('UPDATE catalog_professionals SET services_version = $2 WHERE id = $1', [professionalId, servicesVersion]);
    return true;
  }
}
