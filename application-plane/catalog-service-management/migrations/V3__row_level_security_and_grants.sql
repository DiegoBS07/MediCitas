-- =============================================================================
-- catalog-service-management — RLS and grants
-- Actor roles: cat_clinic_admin (catalog:manage), cat_receptionist and
-- cat_professional (catalog:read), cat_system (replicas, saga validation).
-- =============================================================================

ALTER TABLE tenants               ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants               FORCE ROW LEVEL SECURITY;
ALTER TABLE specialties           ENABLE ROW LEVEL SECURITY;
ALTER TABLE specialties           FORCE ROW LEVEL SECURITY;
ALTER TABLE services              ENABLE ROW LEVEL SECURITY;
ALTER TABLE services              FORCE ROW LEVEL SECURITY;
ALTER TABLE professionals         ENABLE ROW LEVEL SECURITY;
ALTER TABLE professionals         FORCE ROW LEVEL SECURITY;
ALTER TABLE professional_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_services FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants
    USING (id = app.current_tenant_id()) WITH CHECK (id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON specialties
    USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON services
    USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON professionals
    USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON professional_services
    USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- Reads for every actor (catalog:read) and evidence roles.
GRANT SELECT ON tenants, specialties, services, professionals, professional_services
    TO ${rolePrefix}_actor, ${rolePrefix}_readonly, ${rolePrefix}_bench_norls;

-- Tenant replica projector.
GRANT INSERT, UPDATE ON tenants TO ${rolePrefix}_system;

-- catalog:manage
GRANT INSERT ON specialties, services, professionals TO ${rolePrefix}_clinic_admin;
GRANT UPDATE (name, duration_minutes, status, version, updated_at) ON services TO ${rolePrefix}_clinic_admin;
GRANT UPDATE (display_name, license_number, specialty_id, status, version, services_version, updated_at)
    ON professionals TO ${rolePrefix}_clinic_admin;
GRANT INSERT, DELETE ON professional_services TO ${rolePrefix}_clinic_admin;

-- System: deactivate a professional when the linked user is deactivated (TenantUserDeactivated).
GRANT UPDATE (status, version, updated_at) ON professionals TO ${rolePrefix}_system;
