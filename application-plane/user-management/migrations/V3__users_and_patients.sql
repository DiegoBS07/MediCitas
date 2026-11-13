-- =============================================================================
-- user-management (database medicitas_user, schema identity) — RF2, RF14
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tenant replica (fed by TenantOnboarded)
-- -----------------------------------------------------------------------------
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

COMMENT ON TABLE tenants IS 'Read replica of control-plane tenants (only active tenants are replicated). FK target for tenant_id.';
COMMENT ON COLUMN tenants.version IS 'aggregateVersion of the last applied event (older events are ignored).';
COMMENT ON COLUMN tenants.replicated_at IS 'When the replica row was last written.';

-- -----------------------------------------------------------------------------
-- Users (identity mirror; credentials live in Keycloak)
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id                    uuid        PRIMARY KEY,
    tenant_id             uuid        NOT NULL REFERENCES tenants (id),
    keycloak_subject      uuid,
    email                 text        NOT NULL,
    first_name            text        NOT NULL,
    last_name             text        NOT NULL,
    role                  text        NOT NULL REFERENCES roles (code),
    status                text        NOT NULL DEFAULT 'provisioning',
    provisioning_saga_id  uuid,
    version               integer     NOT NULL DEFAULT 1,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    deactivated_at        timestamptz,
    CONSTRAINT users_keycloak_subject_unique UNIQUE (keycloak_subject),
    CONSTRAINT users_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT users_role_is_tenant_role CHECK (role <> 'platform_admin'),
    CONSTRAINT users_status CHECK (status IN ('provisioning', 'active', 'inactive', 'provisioning_failed')),
    CONSTRAINT users_active_has_subject CHECK (status NOT IN ('active', 'inactive') OR keycloak_subject IS NOT NULL),
    CONSTRAINT users_inactive_has_timestamp CHECK ((status = 'inactive') = (deactivated_at IS NOT NULL)),
    CONSTRAINT users_email_format CHECK (char_length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT users_first_name_length CHECK (char_length(btrim(first_name)) BETWEEN 1 AND 80),
    CONSTRAINT users_last_name_length CHECK (char_length(btrim(last_name)) BETWEEN 1 AND 80),
    CONSTRAINT users_version_positive CHECK (version >= 1)
);

COMMENT ON TABLE users IS 'Clinic users (RF2). Stores only the Keycloak subject, the tenant and the role; credentials are in Keycloak.';
COMMENT ON COLUMN users.keycloak_subject IS 'Keycloak user id (token sub). NULL while provisioning.';
COMMENT ON COLUMN users.email IS 'Login e-mail; unique realm-wide because it is the Keycloak username.';
COMMENT ON COLUMN users.role IS 'Single MediCitas role within the clinic (never platform_admin).';
COMMENT ON COLUMN users.status IS 'provisioning → active → inactive (logical delete); provisioning_failed after compensation.';
COMMENT ON COLUMN users.provisioning_saga_id IS 'user-management-orchestrator saga that created the user (NULL for the onboarding first admin).';
COMMENT ON COLUMN users.deactivated_at IS 'Logical deletion timestamp.';

-- Realm-wide uniqueness (Keycloak username = e-mail). Failed provisioning frees the address.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE status <> 'provisioning_failed';
COMMENT ON INDEX users_email_unique IS 'E-mail uniqueness (EMAIL_TAKEN); case-insensitive.';

CREATE INDEX users_tenant_listing_idx ON users (tenant_id, last_name, first_name, id);
COMMENT ON INDEX users_tenant_listing_idx IS 'GET /users keyset pagination ordered by last name, first name, id.';

CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Invariant: a tenant always keeps at least one active clinic admin (LAST_CLINIC_ADMIN).
-- The tenant replica row is the serialization anchor, so concurrent demotions cannot both pass.
CREATE OR REPLACE FUNCTION users_keep_last_clinic_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.role = 'clinic_admin' AND OLD.status = 'active'
       AND (NEW.role <> 'clinic_admin' OR NEW.status <> 'active') THEN
        PERFORM 1 FROM tenants WHERE id = OLD.tenant_id FOR UPDATE;
        IF NOT EXISTS (
            SELECT 1 FROM users
            WHERE tenant_id = OLD.tenant_id AND role = 'clinic_admin' AND status = 'active' AND id <> OLD.id
        ) THEN
            RAISE EXCEPTION 'the last active clinic admin of a tenant cannot be demoted or deactivated'
                USING ERRCODE = 'check_violation', CONSTRAINT = 'users_last_clinic_admin';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_keep_last_clinic_admin BEFORE UPDATE OF role, status ON users
    FOR EACH ROW EXECUTE FUNCTION users_keep_last_clinic_admin();

-- -----------------------------------------------------------------------------
-- Patients (RF14). Contact columns are audited on read/write (RF18, via outbox).
-- -----------------------------------------------------------------------------
CREATE TABLE patients (
    id                     uuid        PRIMARY KEY,
    tenant_id              uuid        NOT NULL REFERENCES tenants (id),
    identification_type    text        NOT NULL,
    identification_number  text        NOT NULL,
    first_name             text        NOT NULL,
    last_name              text        NOT NULL,
    birth_date             date        NOT NULL,
    email                  text,
    phone                  text,
    address                text,
    status                 text        NOT NULL DEFAULT 'active',
    created_by_subject     uuid        NOT NULL,
    version                integer     NOT NULL DEFAULT 1,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT patients_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT patients_identification_unique UNIQUE (tenant_id, identification_type, identification_number),
    CONSTRAINT patients_identification_type CHECK (identification_type IN ('national_id', 'passport', 'residence_card', 'other')),
    CONSTRAINT patients_identification_number_format CHECK (identification_number ~ '^[A-Za-z0-9-]{3,30}$'),
    CONSTRAINT patients_first_name_length CHECK (char_length(btrim(first_name)) BETWEEN 1 AND 80),
    CONSTRAINT patients_last_name_length CHECK (char_length(btrim(last_name)) BETWEEN 1 AND 80),
    CONSTRAINT patients_birth_date_floor CHECK (birth_date >= DATE '1900-01-01'),
    CONSTRAINT patients_email_format CHECK (email IS NULL OR (char_length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
    CONSTRAINT patients_phone_format CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ()-]{7,20}$'),
    CONSTRAINT patients_address_length CHECK (address IS NULL OR char_length(address) <= 300),
    CONSTRAINT patients_status CHECK (status IN ('active', 'inactive')),
    CONSTRAINT patients_version_positive CHECK (version >= 1)
);

COMMENT ON TABLE patients IS 'Patients of a clinic (RF14). Not system users. Reads/writes of contact columns produce PatientContactAccessed audit events.';
COMMENT ON COLUMN patients.identification_type IS 'Kind of identity document.';
COMMENT ON COLUMN patients.identification_number IS 'Document number, unique per tenant and type.';
COMMENT ON COLUMN patients.birth_date IS 'Date of birth (not in the future; enforced by trigger).';
COMMENT ON COLUMN patients.email IS 'Contact data (audited).';
COMMENT ON COLUMN patients.phone IS 'Contact data (audited).';
COMMENT ON COLUMN patients.address IS 'Contact data (audited).';
COMMENT ON COLUMN patients.created_by_subject IS 'Keycloak subject of the user who registered the patient.';

CREATE INDEX patients_last_name_search_idx ON patients (tenant_id, lower(last_name) text_pattern_ops, id);
COMMENT ON INDEX patients_last_name_search_idx IS 'GET /patients?q= prefix search by last name within the tenant.';
CREATE INDEX patients_identification_search_idx ON patients (tenant_id, identification_number text_pattern_ops);
COMMENT ON INDEX patients_identification_search_idx IS 'GET /patients?q= prefix search by identification number within the tenant.';

CREATE OR REPLACE FUNCTION patients_birth_date_not_future() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.birth_date > current_date THEN
        RAISE EXCEPTION 'birth date cannot be in the future'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'patients_birth_date_not_future';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER patients_birth_date_not_future BEFORE INSERT OR UPDATE OF birth_date ON patients
    FOR EACH ROW EXECUTE FUNCTION patients_birth_date_not_future();

CREATE TRIGGER patients_touch_updated_at BEFORE UPDATE ON patients
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
