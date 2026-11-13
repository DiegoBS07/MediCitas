-- =============================================================================
-- scheduler-management — appointments (RF9–RF13), clinical notes (RF15),
-- audit log (RF18/RF19). Invariants I1–I4, I6, I7 are enforced HERE, by the engine.
-- =============================================================================

CREATE TABLE appointments (
    id                           uuid        PRIMARY KEY,
    tenant_id                    uuid        NOT NULL REFERENCES tenants (id),
    patient_id                   uuid        NOT NULL,
    professional_id              uuid        NOT NULL,
    service_id                   uuid        NOT NULL,
    slot                         tstzrange   NOT NULL,
    starts_at                    timestamptz GENERATED ALWAYS AS (lower(slot)) STORED,
    ends_at                      timestamptz GENERATED ALWAYS AS (upper(slot)) STORED,
    status                       text        NOT NULL,
    hold_expires_at              timestamptz,
    release_reason_code          text,
    saga_id                      uuid,
    rescheduled_from_id          uuid,
    booked_by_subject            uuid        NOT NULL,
    cancel_reason                text,
    cancelled_by_subject         uuid,
    cancelled_at                 timestamptz,
    outcome_recorded_by_subject  uuid,
    outcome_recorded_at          timestamptz,
    version                      integer     NOT NULL DEFAULT 1,
    created_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT appointments_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT appointments_professional_fk FOREIGN KEY (tenant_id, professional_id)
        REFERENCES catalog_professionals (tenant_id, id),
    CONSTRAINT appointments_service_fk FOREIGN KEY (tenant_id, service_id)
        REFERENCES catalog_services (tenant_id, id),
    CONSTRAINT appointments_rescheduled_from_fk FOREIGN KEY (tenant_id, rescheduled_from_id)
        REFERENCES appointments (tenant_id, id),
    CONSTRAINT appointments_status CHECK (status IN (
        'held', 'released', 'booked', 'attended', 'no_show', 'cancelled', 'rescheduled')),
    CONSTRAINT appointments_slot_bounded CHECK (
        NOT isempty(slot) AND NOT lower_inf(slot) AND NOT upper_inf(slot)
        AND lower_inc(slot) AND NOT upper_inc(slot)),
    CONSTRAINT appointments_held_has_expiry CHECK (status <> 'held' OR hold_expires_at IS NOT NULL),
    CONSTRAINT appointments_released_has_reason CHECK ((status = 'released') = (release_reason_code IS NOT NULL)),
    CONSTRAINT appointments_cancelled_consistency CHECK (
        (status = 'cancelled') = (cancelled_at IS NOT NULL)
        AND (cancelled_at IS NULL OR (cancelled_by_subject IS NOT NULL
             AND char_length(btrim(cancel_reason)) BETWEEN 1 AND 500))),
    CONSTRAINT appointments_outcome_consistency CHECK (
        (status IN ('attended', 'no_show')) = (outcome_recorded_at IS NOT NULL)
        AND (outcome_recorded_at IS NULL OR outcome_recorded_by_subject IS NOT NULL)),
    CONSTRAINT appointments_version_positive CHECK (version >= 1),
    -- I1: a professional never has two active appointments whose intervals overlap.
    CONSTRAINT appointments_no_professional_overlap EXCLUDE USING gist (
        tenant_id WITH =, professional_id WITH =, slot WITH &&)
        WHERE (status IN ('held', 'booked')),
    -- I2: a patient never has two active overlapping appointments within the clinic.
    CONSTRAINT appointments_no_patient_overlap EXCLUDE USING gist (
        tenant_id WITH =, patient_id WITH =, slot WITH &&)
        WHERE (status IN ('held', 'booked'))
);

COMMENT ON TABLE appointments IS
    'Appointment aggregate (owner: scheduler-management). Active = held or booked; only active rows occupy the agenda (I1, I2, I7).';
COMMENT ON COLUMN appointments.patient_id IS 'patients.id in user-management (logical reference validated by the booking saga).';
COMMENT ON COLUMN appointments.slot IS 'Occupied interval [start, end); its length is the service duration at booking time (I4). Never updated in place.';
COMMENT ON COLUMN appointments.starts_at IS
    'Generated lower(slot). Exists because range functions/operators are not LEAKPROOF: under RLS they cannot be index conditions, while timestamptz comparisons can.';
COMMENT ON COLUMN appointments.ends_at IS 'Generated upper(slot); see starts_at.';
COMMENT ON COLUMN appointments.status IS
    'held (internal saga hold) → booked | released; booked → attended | no_show | cancelled | rescheduled (RF13). Final states have no exit.';
COMMENT ON COLUMN appointments.hold_expires_at IS 'Expiry of a held slot; the sweeper releases expired holds.';
COMMENT ON COLUMN appointments.release_reason_code IS 'Why a hold was released (saga compensation or HOLD_EXPIRED).';
COMMENT ON COLUMN appointments.saga_id IS 'Booking saga that created the row (NULL for reschedule successors and seeds).';
COMMENT ON COLUMN appointments.rescheduled_from_id IS 'Previous appointment when this row is the result of a reschedule (RF10).';
COMMENT ON COLUMN appointments.booked_by_subject IS 'Keycloak subject of the user who booked or rescheduled.';
COMMENT ON COLUMN appointments.cancel_reason IS 'Cancellation reason (RF11).';
COMMENT ON COLUMN appointments.cancelled_by_subject IS 'User who cancelled (RF11).';
COMMENT ON COLUMN appointments.outcome_recorded_by_subject IS 'User who recorded attended/no_show (RF12).';

CREATE UNIQUE INDEX appointments_rescheduled_from_unique ON appointments (tenant_id, rescheduled_from_id)
    WHERE rescheduled_from_id IS NOT NULL;
COMMENT ON INDEX appointments_rescheduled_from_unique IS 'A rescheduled appointment has at most one successor.';

CREATE INDEX appointments_active_professional_start_idx
    ON appointments (tenant_id, professional_id, starts_at) INCLUDE (ends_at)
    WHERE status IN ('held', 'booked');
COMMENT ON INDEX appointments_active_professional_start_idx IS
    'RF7 (and booking checks): active appointments of one professional around a date; RLS-compatible (leakproof timestamptz operators).';

CREATE INDEX appointments_tenant_start_idx ON appointments (tenant_id, starts_at) INCLUDE (status, professional_id);
COMMENT ON INDEX appointments_tenant_start_idx IS 'RF20 day agenda (clinic-wide) and RF21 status counts by date range.';

CREATE INDEX appointments_patient_history_idx ON appointments (tenant_id, patient_id, starts_at DESC);
COMMENT ON INDEX appointments_patient_history_idx IS 'RF16 patient history ordered by start descending.';

CREATE INDEX appointments_held_expiry_idx ON appointments (hold_expires_at) WHERE status = 'held';
COMMENT ON INDEX appointments_held_expiry_idx IS 'Hold-expiry sweeper.';

-- -----------------------------------------------------------------------------
-- Booking rules evaluated on every INSERT (defense in depth for I3/I4).
-- The service also checks them first to return precise errors; the database is
-- the final authority. Errors carry stable constraint names mapped to API codes.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION appointments_validate_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_timezone        text;
    v_prof_status     text;
    v_duration        integer;
    v_service_status  text;
    v_step            integer;
    v_local_date      date;
    v_block_start     timestamptz;
BEGIN
    IF NEW.status NOT IN ('held', 'booked') AND current_user <> '${rolePrefix}_owner' THEN
        RAISE EXCEPTION 'appointments can only be created as held or booked'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_initial_status';
    END IF;

    -- Serialization anchor. A no-op when the caller already holds it.
    PERFORM 1 FROM professional_agendas
    WHERE tenant_id = NEW.tenant_id AND professional_id = NEW.professional_id
    FOR SHARE;

    SELECT t.timezone INTO v_timezone FROM tenants t WHERE t.id = NEW.tenant_id;

    SELECT p.status INTO v_prof_status
    FROM catalog_professionals p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.professional_id;
    IF v_prof_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'professional is not active'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_professional_active';
    END IF;

    SELECT s.duration_minutes, s.status INTO v_duration, v_service_status
    FROM catalog_services s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.service_id;
    IF v_service_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'service is not active'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_service_active';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM catalog_professional_services ps
        WHERE ps.tenant_id = NEW.tenant_id AND ps.professional_id = NEW.professional_id
          AND ps.service_id = NEW.service_id
    ) THEN
        RAISE EXCEPTION 'professional does not offer the service'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_professional_offers_service';
    END IF;

    -- I4: the slot length is exactly the service duration.
    IF upper(NEW.slot) - lower(NEW.slot) <> make_interval(mins => v_duration) THEN
        RAISE EXCEPTION 'slot length must equal the service duration (% minutes)', v_duration
            USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_duration_matches_service';
    END IF;

    -- I3 (part 1): fully inside one weekly block of the local weekday.
    v_local_date := (lower(NEW.slot) AT TIME ZONE v_timezone)::date;

    SELECT (v_local_date + b.start_time) AT TIME ZONE v_timezone INTO v_block_start
    FROM weekly_schedule_blocks b
    WHERE b.tenant_id = NEW.tenant_id
      AND b.professional_id = NEW.professional_id
      AND b.day_of_week = extract(isodow FROM v_local_date)
      AND (v_local_date + b.start_time) AT TIME ZONE v_timezone <= lower(NEW.slot)
      AND (v_local_date + b.end_time) AT TIME ZONE v_timezone >= upper(NEW.slot);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'slot is outside the working hours of the professional'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_within_working_hours';
    END IF;

    -- Grid alignment relative to the block start.
    SELECT slot_step_minutes INTO v_step FROM scheduling_settings;
    IF (extract(epoch FROM lower(NEW.slot) - v_block_start)::bigint % (v_step * 60)) <> 0 THEN
        RAISE EXCEPTION 'slot start is not aligned to the % minute grid', v_step
            USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_slot_aligned';
    END IF;

    -- I3 (part 2): not inside an active calendar block.
    IF EXISTS (
        SELECT 1 FROM calendar_blocks cb
        WHERE cb.tenant_id = NEW.tenant_id AND cb.professional_id = NEW.professional_id
          AND cb.status = 'active' AND cb.period && NEW.slot
    ) THEN
        RAISE EXCEPTION 'slot overlaps a calendar block'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_outside_calendar_blocks';
    END IF;

    -- RF12 consistency for historical rows inserted by seeds.
    IF NEW.status IN ('attended', 'no_show') AND lower(NEW.slot) > now() THEN
        RAISE EXCEPTION 'an outcome cannot precede the start time'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_outcome_after_start';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER appointments_validate_insert
    BEFORE INSERT ON appointments
    FOR EACH ROW EXECUTE FUNCTION appointments_validate_insert();

-- -----------------------------------------------------------------------------
-- RF13 state machine + immutability of the booked facts (I4: slot never altered).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION appointments_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.patient_id <> OLD.patient_id
       OR NEW.professional_id <> OLD.professional_id OR NEW.service_id <> OLD.service_id
       OR NEW.slot <> OLD.slot OR NEW.saga_id IS DISTINCT FROM OLD.saga_id
       OR NEW.rescheduled_from_id IS DISTINCT FROM OLD.rescheduled_from_id
       OR NEW.booked_by_subject <> OLD.booked_by_subject OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'booked facts of an appointment are immutable'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_immutable_facts';
    END IF;

    IF NEW.status <> OLD.status AND NOT (
           (OLD.status = 'held'   AND NEW.status IN ('booked', 'released'))
        OR (OLD.status = 'booked' AND NEW.status IN ('attended', 'no_show', 'cancelled', 'rescheduled'))
    ) THEN
        RAISE EXCEPTION 'invalid appointment transition % -> %', OLD.status, NEW.status
            USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_valid_transition';
    END IF;

    -- RF12: an outcome is admitted only once the start time has passed (database clock).
    IF NEW.status IN ('attended', 'no_show') AND OLD.status = 'booked' AND now() < lower(OLD.slot) THEN
        RAISE EXCEPTION 'an outcome can only be recorded after the start time'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_outcome_after_start';
    END IF;

    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER appointments_guard_update
    BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION appointments_guard_update();

CREATE TRIGGER appointments_no_delete
    BEFORE DELETE ON appointments
    FOR EACH ROW EXECUTE FUNCTION app.reject_modification();

-- -----------------------------------------------------------------------------
-- Clinical notes (RF15): one immutable note per attended appointment.
-- -----------------------------------------------------------------------------
CREATE TABLE clinical_notes (
    id              uuid        PRIMARY KEY,
    tenant_id       uuid        NOT NULL,
    appointment_id  uuid        NOT NULL,
    author_subject  uuid        NOT NULL,
    content         text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT clinical_notes_appointment_unique UNIQUE (tenant_id, appointment_id),
    CONSTRAINT clinical_notes_appointment_fk FOREIGN KEY (tenant_id, appointment_id)
        REFERENCES appointments (tenant_id, id),
    CONSTRAINT clinical_notes_content_length CHECK (char_length(btrim(content)) BETWEEN 1 AND 20000)
);
COMMENT ON TABLE clinical_notes IS
    'Clinical note of an attended appointment (RF15): the most sensitive data. Written only by the appointment professional; immutable; every read/write is audited.';
COMMENT ON COLUMN clinical_notes.author_subject IS 'Keycloak subject of the authoring professional (must be the appointment professional).';
COMMENT ON COLUMN clinical_notes.content IS 'Free-text note. Never copied to events, logs or the audit log.';

CREATE OR REPLACE FUNCTION clinical_notes_validate_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_status   text;
    v_subject  uuid;
BEGIN
    SELECT a.status, p.keycloak_subject INTO v_status, v_subject
    FROM appointments a
    JOIN catalog_professionals p ON p.tenant_id = a.tenant_id AND p.id = a.professional_id
    WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.appointment_id;

    IF v_status IS DISTINCT FROM 'attended' THEN
        RAISE EXCEPTION 'a clinical note requires an attended appointment'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'clinical_notes_requires_attended';
    END IF;
    IF v_subject IS DISTINCT FROM NEW.author_subject THEN
        RAISE EXCEPTION 'only the professional of the appointment may write its note'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'clinical_notes_author_is_professional';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER clinical_notes_validate_insert
    BEFORE INSERT ON clinical_notes
    FOR EACH ROW EXECUTE FUNCTION clinical_notes_validate_insert();
CREATE TRIGGER clinical_notes_immutable
    BEFORE UPDATE OR DELETE ON clinical_notes
    FOR EACH ROW EXECUTE FUNCTION app.reject_modification();
CREATE TRIGGER clinical_notes_no_truncate
    BEFORE TRUNCATE ON clinical_notes
    FOR EACH STATEMENT EXECUTE FUNCTION app.reject_modification();

-- -----------------------------------------------------------------------------
-- Audit log (RF18/RF19, I6): append-only, enforced by grants + triggers + RLS.
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid        NOT NULL REFERENCES tenants (id),
    occurred_at        timestamptz NOT NULL,
    recorded_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor_subject      uuid        NOT NULL,
    actor_role         text        NOT NULL,
    patient_id         uuid        NOT NULL,
    resource_type      text        NOT NULL,
    resource_id        uuid        NOT NULL,
    action             text        NOT NULL,
    outcome            text        NOT NULL,
    correlation_id     uuid        NOT NULL,
    source_service     text        NOT NULL,
    source_message_id  uuid,
    CONSTRAINT audit_log_source_message_unique UNIQUE (source_message_id),
    CONSTRAINT audit_log_actor_role CHECK (actor_role IN ('clinic_admin', 'receptionist', 'health_professional')),
    CONSTRAINT audit_log_resource_type CHECK (resource_type IN ('clinical_note', 'patient_contact')),
    CONSTRAINT audit_log_action CHECK (action IN ('read', 'create', 'update')),
    CONSTRAINT audit_log_outcome CHECK (outcome IN ('success', 'denied')),
    CONSTRAINT audit_log_source_service CHECK (source_service IN ('scheduler-management', 'user-management')),
    CONSTRAINT audit_log_occurred_not_after_recorded CHECK (occurred_at <= recorded_at + interval '5 minutes')
);
COMMENT ON TABLE audit_log IS
    'Append-only audit of every read/write of clinical notes and patient contact data (RF18): who, what, which patient, when. Never contains note text or contact values.';
COMMENT ON COLUMN audit_log.occurred_at IS 'When the access happened (DB clock for notes; source event time for patient contact).';
COMMENT ON COLUMN audit_log.recorded_at IS 'When the row was appended (database clock).';
COMMENT ON COLUMN audit_log.actor_subject IS 'Keycloak subject of the user who accessed the data.';
COMMENT ON COLUMN audit_log.patient_id IS 'Patient whose data was accessed.';
COMMENT ON COLUMN audit_log.resource_type IS 'clinical_note or patient_contact.';
COMMENT ON COLUMN audit_log.resource_id IS 'Note id or patient id.';
COMMENT ON COLUMN audit_log.outcome IS 'success, or denied for refused attempts.';
COMMENT ON COLUMN audit_log.source_message_id IS 'messageId of the PatientContactAccessed event (de-duplication); NULL for local note accesses.';

CREATE INDEX audit_log_tenant_time_idx ON audit_log (tenant_id, occurred_at DESC, id);
COMMENT ON INDEX audit_log_tenant_time_idx IS 'RF19 date-range filter, newest first.';
CREATE INDEX audit_log_tenant_patient_idx ON audit_log (tenant_id, patient_id, occurred_at DESC);
COMMENT ON INDEX audit_log_tenant_patient_idx IS 'RF19 patient filter.';
CREATE INDEX audit_log_tenant_actor_idx ON audit_log (tenant_id, actor_subject, occurred_at DESC);
COMMENT ON INDEX audit_log_tenant_actor_idx IS 'RF19 user filter.';

CREATE TRIGGER audit_log_append_only
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION app.reject_modification();
CREATE TRIGGER audit_log_no_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION app.reject_modification();
