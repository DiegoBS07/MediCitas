-- =============================================================================
-- user-management — Row-Level Security and least-privilege grants
-- Actor roles: um_clinic_admin, um_receptionist, um_professional, um_system.
-- =============================================================================

-- RLS: every tenant-scoped table admits only rows of app.current_tenant_id().
ALTER TABLE tenants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants  FORCE ROW LEVEL SECURITY;
ALTER TABLE users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE users    FORCE ROW LEVEL SECURITY;
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants
    USING (id = app.current_tenant_id())
    WITH CHECK (id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON users
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON patients
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Reference data (not tenant-scoped).
GRANT SELECT ON roles, permissions, role_permissions
    TO ${rolePrefix}_actor, ${rolePrefix}_readonly, ${rolePrefix}_bench_norls;

-- Tenant replica: projector writes; actors read their own tenant.
GRANT SELECT ON tenants TO ${rolePrefix}_actor, ${rolePrefix}_readonly, ${rolePrefix}_bench_norls;
GRANT INSERT, UPDATE ON tenants TO ${rolePrefix}_system;

-- Users: only the clinic admin reads (users:manage); the saga consumer writes.
GRANT SELECT ON users TO ${rolePrefix}_clinic_admin, ${rolePrefix}_system;
GRANT INSERT, UPDATE (keycloak_subject, role, status, version, deactivated_at, updated_at)
    ON users TO ${rolePrefix}_system;
GRANT SELECT (id, tenant_id, role, status, created_at, updated_at)
    ON users TO ${rolePrefix}_readonly, ${rolePrefix}_bench_norls;

-- Patients: admin and reception read/write; professional read-only (matrix RF14).
GRANT SELECT ON patients TO ${rolePrefix}_clinic_admin, ${rolePrefix}_receptionist, ${rolePrefix}_professional,
    ${rolePrefix}_system;
GRANT INSERT ON patients TO ${rolePrefix}_clinic_admin, ${rolePrefix}_receptionist, ${rolePrefix}_system;
GRANT UPDATE (first_name, last_name, birth_date, email, phone, address, status, version, updated_at)
    ON patients TO ${rolePrefix}_clinic_admin, ${rolePrefix}_receptionist;
-- Evidence roles never see contact data.
GRANT SELECT (id, tenant_id, identification_type, identification_number, first_name, last_name, status,
              created_at, updated_at)
    ON patients TO ${rolePrefix}_readonly, ${rolePrefix}_bench_norls;
