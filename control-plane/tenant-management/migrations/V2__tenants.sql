-- =============================================================================
-- tenant-management (database medicitas_tenant, schema tenancy) — RF1
-- Control-plane table: not tenant-scoped, protected by role grants (platform only).
-- =============================================================================

CREATE TABLE tenants (
    id                   uuid        PRIMARY KEY,
    slug                 text        NOT NULL,
    name                 text        NOT NULL,
    timezone             text        NOT NULL,
    status               text        NOT NULL DEFAULT 'provisioning',
    failure_reason_code  text,
    onboarding_saga_id   uuid        NOT NULL,
    version              integer     NOT NULL DEFAULT 1,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    activated_at         timestamptz,
    CONSTRAINT tenants_slug_unique UNIQUE (slug),
    CONSTRAINT tenants_onboarding_saga_unique UNIQUE (onboarding_saga_id),
    CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
    CONSTRAINT tenants_name_length CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
    CONSTRAINT tenants_status CHECK (status IN ('provisioning', 'active', 'onboarding_failed')),
    CONSTRAINT tenants_active_has_activation CHECK ((status = 'active') = (activated_at IS NOT NULL)),
    CONSTRAINT tenants_failed_has_reason CHECK ((status = 'onboarding_failed') = (failure_reason_code IS NOT NULL)),
    CONSTRAINT tenants_version_positive CHECK (version >= 1)
);

COMMENT ON TABLE tenants IS 'Clinics (tenants) of the SaaS. Source of truth for tenant identity, name and timezone (RF1).';
COMMENT ON COLUMN tenants.id IS 'Tenant UUID; emitted as the tenant_id claim by Keycloak and used as tenant_id in every application database.';
COMMENT ON COLUMN tenants.slug IS 'Human-readable unique identifier of the clinic (RF1 "identificador").';
COMMENT ON COLUMN tenants.name IS 'Clinic display name.';
COMMENT ON COLUMN tenants.timezone IS 'IANA timezone of the clinic; all local dates and working hours are interpreted in it.';
COMMENT ON COLUMN tenants.status IS 'provisioning (saga running), active, onboarding_failed (compensated).';
COMMENT ON COLUMN tenants.failure_reason_code IS 'Stable error code of a failed onboarding.';
COMMENT ON COLUMN tenants.onboarding_saga_id IS 'Onboarding saga that created the tenant (idempotency of CreateTenantCommand).';
COMMENT ON COLUMN tenants.version IS 'Aggregate version, carried as aggregateVersion in TenantOnboarded.';
COMMENT ON COLUMN tenants.activated_at IS 'When onboarding completed.';

CREATE OR REPLACE FUNCTION tenants_validate_timezone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
        RAISE EXCEPTION 'invalid IANA timezone: %', NEW.timezone
            USING ERRCODE = 'check_violation', CONSTRAINT = 'tenants_timezone_valid';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_validate_timezone
    BEFORE INSERT OR UPDATE OF timezone ON tenants
    FOR EACH ROW EXECUTE FUNCTION tenants_validate_timezone();

CREATE TRIGGER tenants_touch_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Grants: platform reads; command consumer writes; evidence reads.
GRANT SELECT ON tenants TO ${rolePrefix}_platform_admin, ${rolePrefix}_readonly;
GRANT SELECT, INSERT, UPDATE (status, failure_reason_code, version, activated_at, updated_at)
    ON tenants TO ${rolePrefix}_system;
