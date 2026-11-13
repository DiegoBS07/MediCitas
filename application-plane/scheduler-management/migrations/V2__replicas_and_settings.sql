-- =============================================================================
-- scheduler-management (database medicitas_scheduler, schema scheduling)
-- Read replicas fed by domain events and settings.
-- These tables are DELIBERATE DENORMALIZATIONS: copies of facts owned by
-- tenant-management and catalog-service-management, kept so that RF5/RF7/RF9
-- are evaluated locally. Ordering is protected by aggregate versions.
-- =============================================================================

CREATE TABLE tenants (
    id             uuid        PRIMARY KEY,
    slug           text        NOT NULL,
    name           text        NOT NULL,
    timezone       text        NOT NULL,
    status         text        NOT NULL,
    version        integer     NOT NULL,
    replicated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT tenants_status CHECK (status IN ('active')),
    CONSTRAINT tenants_version_positive CHECK (version >= 1)
);
COMMENT ON TABLE tenants IS 'Replica of control-plane tenants (TenantOnboarded). Source of the clinic timezone for local dates and working hours.';
COMMENT ON COLUMN tenants.timezone IS 'IANA timezone used to interpret weekly schedules and local dates.';

CREATE TABLE catalog_services (
    id                uuid        NOT NULL,
    tenant_id         uuid        NOT NULL REFERENCES tenants (id),
    specialty_id      uuid        NOT NULL,
    name              text        NOT NULL,
    duration_minutes  integer     NOT NULL,
    status            text        NOT NULL,
    version           integer     NOT NULL,
    replicated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT catalog_services_pk PRIMARY KEY (id),
    CONSTRAINT catalog_services_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT catalog_services_duration_range CHECK (duration_minutes BETWEEN 5 AND 480 AND duration_minutes % 5 = 0),
    CONSTRAINT catalog_services_status CHECK (status IN ('active', 'inactive')),
    CONSTRAINT catalog_services_version_positive CHECK (version >= 1)
);
COMMENT ON TABLE catalog_services IS 'Replica of catalog services (Service* events): duration and status drive slot length (I4).';
COMMENT ON COLUMN catalog_services.version IS 'Catalog aggregate version; an event is applied only if newer.';

CREATE TABLE catalog_professionals (
    id                uuid        NOT NULL,
    tenant_id         uuid        NOT NULL REFERENCES tenants (id),
    user_id           uuid        NOT NULL,
    keycloak_subject  uuid        NOT NULL,
    display_name      text        NOT NULL,
    specialty_id      uuid        NOT NULL,
    status            text        NOT NULL,
    version           integer     NOT NULL,
    services_version  integer     NOT NULL,
    replicated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT catalog_professionals_pk PRIMARY KEY (id),
    CONSTRAINT catalog_professionals_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT catalog_professionals_subject_unique UNIQUE (keycloak_subject),
    CONSTRAINT catalog_professionals_status CHECK (status IN ('active', 'inactive')),
    CONSTRAINT catalog_professionals_versions_positive CHECK (version >= 1 AND services_version >= 1)
);
COMMENT ON TABLE catalog_professionals IS 'Replica of catalog professionals (Professional* events). keycloak_subject resolves "own" rules (schedule:manage-own, agenda:read-own, RF15).';
COMMENT ON COLUMN catalog_professionals.services_version IS 'Version of the replicated association set (ProfessionalServicesChanged).';

CREATE TABLE catalog_professional_services (
    tenant_id        uuid NOT NULL,
    professional_id  uuid NOT NULL,
    service_id       uuid NOT NULL,
    CONSTRAINT catalog_professional_services_pk PRIMARY KEY (tenant_id, professional_id, service_id),
    CONSTRAINT catalog_professional_services_professional_fk FOREIGN KEY (tenant_id, professional_id)
        REFERENCES catalog_professionals (tenant_id, id),
    CONSTRAINT catalog_professional_services_service_fk FOREIGN KEY (tenant_id, service_id)
        REFERENCES catalog_services (tenant_id, id)
);
COMMENT ON TABLE catalog_professional_services IS 'Replica of the professional–service association set (full set replaced per event).';
CREATE INDEX catalog_professional_services_service_idx ON catalog_professional_services (tenant_id, service_id);
COMMENT ON INDEX catalog_professional_services_service_idx IS 'RF8: professionals offering a service.';

-- -----------------------------------------------------------------------------
-- Agenda anchor (scheduler-owned state, 1:1 with the professional replica)
-- -----------------------------------------------------------------------------
CREATE TABLE professional_agendas (
    tenant_id         uuid        NOT NULL,
    professional_id   uuid        NOT NULL,
    schedule_version  bigint      NOT NULL DEFAULT 0,
    updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT professional_agendas_pk PRIMARY KEY (tenant_id, professional_id),
    CONSTRAINT professional_agendas_professional_fk FOREIGN KEY (tenant_id, professional_id)
        REFERENCES catalog_professionals (tenant_id, id),
    CONSTRAINT professional_agendas_version_non_negative CHECK (schedule_version >= 0)
);
COMMENT ON TABLE professional_agendas IS
    'Lock anchor of a professional agenda: bookings take FOR SHARE, schedule/block writers take FOR UPDATE. schedule_version is part of the availability cache key.';
COMMENT ON COLUMN professional_agendas.schedule_version IS 'Bumped on weekly schedule changes and professional status changes.';

CREATE OR REPLACE FUNCTION catalog_professionals_create_agenda() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO professional_agendas (tenant_id, professional_id)
    VALUES (NEW.tenant_id, NEW.id)
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE TRIGGER catalog_professionals_create_agenda
    AFTER INSERT ON catalog_professionals
    FOR EACH ROW EXECUTE FUNCTION catalog_professionals_create_agenda();

-- -----------------------------------------------------------------------------
-- Settings (singleton)
-- -----------------------------------------------------------------------------
CREATE TABLE scheduling_settings (
    singleton               boolean PRIMARY KEY DEFAULT true,
    slot_step_minutes       integer NOT NULL DEFAULT 15,
    booking_horizon_days    integer NOT NULL DEFAULT 180,
    hold_ttl_seconds        integer NOT NULL DEFAULT 60,
    CONSTRAINT scheduling_settings_singleton CHECK (singleton),
    CONSTRAINT scheduling_settings_step CHECK (slot_step_minutes IN (5, 10, 15, 20, 30, 60)),
    CONSTRAINT scheduling_settings_horizon CHECK (booking_horizon_days BETWEEN 1 AND 730),
    CONSTRAINT scheduling_settings_hold_ttl CHECK (hold_ttl_seconds BETWEEN 10 AND 600)
);
COMMENT ON TABLE scheduling_settings IS 'Single-row scheduling parameters shared by the database rules and the service.';
COMMENT ON COLUMN scheduling_settings.slot_step_minutes IS 'Slot grid step, anchored at each weekly block start.';
COMMENT ON COLUMN scheduling_settings.booking_horizon_days IS 'Maximum days ahead for availability queries and bookings.';
COMMENT ON COLUMN scheduling_settings.hold_ttl_seconds IS 'Lifetime of a held slot before the sweeper releases it.';

INSERT INTO scheduling_settings DEFAULT VALUES;
