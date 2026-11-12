-- =============================================================================
-- scheduler-management — RLS (ADR-0004) and least-privilege grants aligned with
-- the permission matrix (ADR-0009). Actor roles: sch_clinic_admin,
-- sch_receptionist, sch_professional, sch_system.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper: is the given professional the current actor? ("own" rules)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_own_professional(p_professional_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM ${schema}.catalog_professionals cp
        WHERE cp.tenant_id = app.current_tenant_id()
          AND cp.id = p_professional_id
          AND cp.keycloak_subject = app.current_actor_subject());
$$;
COMMENT ON FUNCTION is_own_professional(uuid) IS
    'True when the professional''s Keycloak subject equals app.actor_subject (schedule:manage-own, agenda:read-own, RF15).';

-- -----------------------------------------------------------------------------
-- Tenant isolation on every tenant-scoped table
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_table text;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'catalog_services', 'catalog_professionals', 'catalog_professional_services',
        'professional_agendas', 'weekly_schedule_blocks', 'calendar_blocks',
        'availability_versions', 'appointments', 'clinical_notes', 'audit_log']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_table);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', v_table);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app.current_tenant_id()) '
            'WITH CHECK (tenant_id = app.current_tenant_id())', v_table);
    END LOOP;
END;
$$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
    USING (id = app.current_tenant_id()) WITH CHECK (id = app.current_tenant_id());

-- -----------------------------------------------------------------------------
-- Restrictive policies (AND-ed with tenant isolation) for the professional profile
-- -----------------------------------------------------------------------------
-- schedule:manage-own — a professional writes only their own schedule and blocks.
CREATE POLICY own_schedule_insert ON weekly_schedule_blocks AS RESTRICTIVE
    FOR INSERT TO ${rolePrefix}_professional WITH CHECK (is_own_professional(professional_id));
CREATE POLICY own_schedule_delete ON weekly_schedule_blocks AS RESTRICTIVE
    FOR DELETE TO ${rolePrefix}_professional USING (is_own_professional(professional_id));
CREATE POLICY own_blocks_insert ON calendar_blocks AS RESTRICTIVE
    FOR INSERT TO ${rolePrefix}_professional WITH CHECK (is_own_professional(professional_id));
CREATE POLICY own_blocks_update ON calendar_blocks AS RESTRICTIVE
    FOR UPDATE TO ${rolePrefix}_professional
    USING (is_own_professional(professional_id)) WITH CHECK (is_own_professional(professional_id));
CREATE POLICY own_agenda_update ON professional_agendas AS RESTRICTIVE
    FOR UPDATE TO ${rolePrefix}_professional
    USING (is_own_professional(professional_id)) WITH CHECK (is_own_professional(professional_id));

-- appointments:outcome — a professional can only move an appointment to attended/no_show.
CREATE POLICY professional_outcome_only ON appointments AS RESTRICTIVE
    FOR UPDATE TO ${rolePrefix}_professional
    USING (true) WITH CHECK (status IN ('attended', 'no_show'));

-- clinical-notes:own — a professional sees and writes only notes they authored.
CREATE POLICY own_notes ON clinical_notes AS RESTRICTIVE
    FOR ALL TO ${rolePrefix}_professional
    USING (author_subject = app.current_actor_subject())
    WITH CHECK (author_subject = app.current_actor_subject());

-- Background discovery (hold-expiry sweeper) across tenants, column-limited below.
CREATE POLICY worker_discovery ON appointments FOR SELECT TO ${rolePrefix}_worker USING (true);

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Reads common to every actor (schedule:read, availability:read, appointments:read,
-- patient-history:read, agenda, reports).
GRANT SELECT ON tenants, catalog_services, catalog_professionals, catalog_professional_services,
    professional_agendas, weekly_schedule_blocks, calendar_blocks, availability_versions, appointments,
    scheduling_settings
    TO ${rolePrefix}_actor;

-- Replica projectors.
GRANT INSERT, UPDATE ON tenants, catalog_services, catalog_professionals TO ${rolePrefix}_system;
GRANT INSERT, DELETE ON catalog_professional_services TO ${rolePrefix}_system;
GRANT INSERT ON professional_agendas TO ${rolePrefix}_system;

-- Agenda anchor: FOR SHARE/FOR UPDATE need UPDATE on at least one column.
GRANT UPDATE (schedule_version, updated_at) ON professional_agendas
    TO ${rolePrefix}_clinic_admin, ${rolePrefix}_professional, ${rolePrefix}_system;
GRANT UPDATE (updated_at) ON professional_agendas TO ${rolePrefix}_receptionist;

-- Availability versions: every writer of availability bumps them.
GRANT INSERT, UPDATE (version, updated_at) ON availability_versions TO ${rolePrefix}_actor;

-- schedule:manage / schedule:manage-own (RF5, RF6).
GRANT INSERT, DELETE ON weekly_schedule_blocks TO ${rolePrefix}_clinic_admin, ${rolePrefix}_professional;
GRANT INSERT, UPDATE (status, removed_by_subject, removed_at) ON calendar_blocks
    TO ${rolePrefix}_clinic_admin, ${rolePrefix}_professional;

-- Appointments.
--   system: saga holds, confirmation, release, hold expiry (RF9).
GRANT INSERT, UPDATE (status, hold_expires_at, release_reason_code, version, updated_at)
    ON appointments TO ${rolePrefix}_system;
--   clinic_admin / receptionist: reschedule (new row), cancel, outcome (RF10–RF12).
GRANT INSERT, UPDATE (status, cancel_reason, cancelled_by_subject, cancelled_at,
                      outcome_recorded_by_subject, outcome_recorded_at, version, updated_at)
    ON appointments TO ${rolePrefix}_clinic_admin, ${rolePrefix}_receptionist;
--   professional: outcome only (RF12).
GRANT UPDATE (status, outcome_recorded_by_subject, outcome_recorded_at, version, updated_at)
    ON appointments TO ${rolePrefix}_professional;
--   worker: discovery of expired holds only.
GRANT SELECT (id, tenant_id, status, hold_expires_at) ON appointments TO ${rolePrefix}_worker;

-- Clinical notes: only the professional profile (RF15). No UPDATE/DELETE for anyone.
GRANT SELECT, INSERT ON clinical_notes TO ${rolePrefix}_professional;

-- Audit log: every actor appends; only the clinic admin reads (RF19). No UPDATE/DELETE/TRUNCATE.
GRANT INSERT ON audit_log TO ${rolePrefix}_actor;
GRANT SELECT ON audit_log TO ${rolePrefix}_clinic_admin;

-- Evidence roles: no clinical notes, no audit log, no free-text cancel reasons.
GRANT SELECT ON tenants, catalog_services, catalog_professionals, catalog_professional_services,
    professional_agendas, weekly_schedule_blocks, calendar_blocks, availability_versions, scheduling_settings
    TO ${rolePrefix}_readonly, ${rolePrefix}_bench_norls;
GRANT SELECT (id, tenant_id, patient_id, professional_id, service_id, slot, starts_at, ends_at, status, hold_expires_at,
              rescheduled_from_id, created_at, updated_at)
    ON appointments TO ${rolePrefix}_readonly, ${rolePrefix}_bench_norls;
-- Module 2 comparison includes the RF19 audit filter (bench role is test-only, BYPASSRLS, SELECT-only).
GRANT SELECT ON audit_log TO ${rolePrefix}_bench_norls;
