-- =============================================================================
-- catalog-service-management (database medicitas_catalog, schema catalog) — RF3, RF4
-- Professionals live here (not in user-management) so that "a professional only
-- performs services of their specialty" is a local, transactional rule (ADR-0001).
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
COMMENT ON TABLE tenants IS 'Read replica of control-plane tenants (TenantOnboarded). FK target for tenant_id.';

-- -----------------------------------------------------------------------------
CREATE TABLE specialties (
    id          uuid        PRIMARY KEY,
    tenant_id   uuid        NOT NULL REFERENCES tenants (id),
    name        text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT specialties_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT specialties_name_length CHECK (char_length(btrim(name)) BETWEEN 2 AND 80)
);
COMMENT ON TABLE specialties IS 'Medical specialties of a clinic, required by services (RF3) and held by professionals (RF4).';
CREATE UNIQUE INDEX specialties_name_unique ON specialties (tenant_id, lower(name));
COMMENT ON INDEX specialties_name_unique IS 'SPECIALTY_NAME_TAKEN (case-insensitive, per tenant).';

-- -----------------------------------------------------------------------------
CREATE TABLE services (
    id                uuid        PRIMARY KEY,
    tenant_id         uuid        NOT NULL REFERENCES tenants (id),
    specialty_id      uuid        NOT NULL,
    name              text        NOT NULL,
    duration_minutes  integer     NOT NULL,
    status            text        NOT NULL DEFAULT 'active',
    version           integer     NOT NULL DEFAULT 1,
    created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT services_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT services_specialty_fk FOREIGN KEY (tenant_id, specialty_id) REFERENCES specialties (tenant_id, id),
    CONSTRAINT services_name_length CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
    CONSTRAINT services_duration_range CHECK (duration_minutes BETWEEN 5 AND 480 AND duration_minutes % 5 = 0),
    CONSTRAINT services_status CHECK (status IN ('active', 'inactive')),
    CONSTRAINT services_version_positive CHECK (version >= 1)
);
COMMENT ON TABLE services IS 'Service catalog (RF3): type of consultation; its duration defines the slot length (I4).';
COMMENT ON COLUMN services.specialty_id IS 'Specialty required to perform the service (immutable after creation).';
COMMENT ON COLUMN services.duration_minutes IS 'Slot length in minutes (5..480, multiple of 5). Changes affect future bookings only.';
COMMENT ON COLUMN services.version IS 'Aggregate version carried in Service* events (replica ordering).';
CREATE UNIQUE INDEX services_name_unique ON services (tenant_id, lower(name));
COMMENT ON INDEX services_name_unique IS 'SERVICE_NAME_TAKEN (case-insensitive, per tenant).';

-- -----------------------------------------------------------------------------
CREATE TABLE professionals (
    id                uuid        PRIMARY KEY,
    tenant_id         uuid        NOT NULL REFERENCES tenants (id),
    user_id           uuid        NOT NULL,
    keycloak_subject  uuid        NOT NULL,
    specialty_id      uuid        NOT NULL,
    display_name      text        NOT NULL,
    license_number    text        NOT NULL,
    status            text        NOT NULL DEFAULT 'active',
    version           integer     NOT NULL DEFAULT 1,
    services_version  integer     NOT NULL DEFAULT 1,
    created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT professionals_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT professionals_user_unique UNIQUE (tenant_id, user_id),
    CONSTRAINT professionals_subject_unique UNIQUE (keycloak_subject),
    CONSTRAINT professionals_license_unique UNIQUE (tenant_id, license_number),
    CONSTRAINT professionals_specialty_fk FOREIGN KEY (tenant_id, specialty_id) REFERENCES specialties (tenant_id, id),
    CONSTRAINT professionals_display_name_length CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 120),
    CONSTRAINT professionals_license_format CHECK (license_number ~ '^[A-Za-z0-9-]{2,30}$'),
    CONSTRAINT professionals_status CHECK (status IN ('active', 'inactive')),
    CONSTRAINT professionals_versions_positive CHECK (version >= 1 AND services_version >= 1)
);
COMMENT ON TABLE professionals IS 'Health professionals (RF4): practice profile of a user with role health_professional.';
COMMENT ON COLUMN professionals.user_id IS 'users.id in user-management (logical cross-service reference, validated by GetTenantUserQuery).';
COMMENT ON COLUMN professionals.keycloak_subject IS 'Copy of the user''s Keycloak subject (deliberate denormalization: maps token sub → professional for "own" rules).';
COMMENT ON COLUMN professionals.license_number IS 'Professional license / registry number.';
COMMENT ON COLUMN professionals.version IS 'Profile version (ProfessionalRegistered/Updated).';
COMMENT ON COLUMN professionals.services_version IS 'Association-set version (ProfessionalServicesChanged); separate counter so out-of-order events cannot hide each other.';

-- -----------------------------------------------------------------------------
CREATE TABLE professional_services (
    tenant_id        uuid        NOT NULL,
    professional_id  uuid        NOT NULL,
    service_id       uuid        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT professional_services_pk PRIMARY KEY (tenant_id, professional_id, service_id),
    CONSTRAINT professional_services_professional_fk FOREIGN KEY (tenant_id, professional_id)
        REFERENCES professionals (tenant_id, id),
    CONSTRAINT professional_services_service_fk FOREIGN KEY (tenant_id, service_id)
        REFERENCES services (tenant_id, id)
);
COMMENT ON TABLE professional_services IS 'Services a professional is enabled to perform (RF4). Only services of the professional''s specialty.';
CREATE INDEX professional_services_service_idx ON professional_services (tenant_id, service_id);
COMMENT ON INDEX professional_services_service_idx IS 'Reverse lookup: professionals offering a service (GET /professionals?serviceId=, RF8 source).';

-- -----------------------------------------------------------------------------
-- Rules
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION professional_services_specialty_match() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM professionals p
        JOIN services s ON s.tenant_id = p.tenant_id AND s.specialty_id = p.specialty_id
        WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.professional_id AND s.id = NEW.service_id
    ) THEN
        RAISE EXCEPTION 'service specialty does not match the professional specialty'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'professional_services_specialty_match';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER professional_services_specialty_match
    BEFORE INSERT OR UPDATE ON professional_services
    FOR EACH ROW EXECUTE FUNCTION professional_services_specialty_match();

CREATE OR REPLACE FUNCTION professionals_specialty_change_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.specialty_id <> OLD.specialty_id AND EXISTS (
        SELECT 1 FROM professional_services ps
        JOIN services s ON s.tenant_id = ps.tenant_id AND s.id = ps.service_id
        WHERE ps.tenant_id = NEW.tenant_id AND ps.professional_id = NEW.id AND s.specialty_id <> NEW.specialty_id
    ) THEN
        RAISE EXCEPTION 'specialty change conflicts with current service associations'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'professionals_specialty_change_conflict';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER professionals_specialty_change_guard
    BEFORE UPDATE OF specialty_id ON professionals
    FOR EACH ROW EXECUTE FUNCTION professionals_specialty_change_guard();

CREATE TRIGGER services_touch_updated_at BEFORE UPDATE ON services
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER professionals_touch_updated_at BEFORE UPDATE ON professionals
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
