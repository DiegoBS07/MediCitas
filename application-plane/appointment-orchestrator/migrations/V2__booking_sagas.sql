-- =============================================================================
-- appointment-orchestrator (database medicitas_appointment_orchestrator, schema booking) — RF9
-- Booking saga state only (D3): the appointment itself lives in scheduler-management.
-- =============================================================================

CREATE TABLE saga_instances (
    id                uuid        PRIMARY KEY,
    tenant_id         uuid        NOT NULL,
    saga_type         text        NOT NULL DEFAULT 'appointment-booking',
    appointment_id    uuid        NOT NULL,
    patient_id        uuid        NOT NULL,
    professional_id   uuid        NOT NULL,
    service_id        uuid        NOT NULL,
    start_at          timestamptz NOT NULL,
    patient_mode      text        NOT NULL,
    status            text        NOT NULL DEFAULT 'started',
    result            jsonb,
    error_code        text,
    error_detail      text,
    actor_subject     uuid        NOT NULL,
    correlation_id    uuid        NOT NULL,
    deadline_at       timestamptz NOT NULL,
    version           integer     NOT NULL DEFAULT 1,
    created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at      timestamptz,
    CONSTRAINT saga_instances_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT saga_instances_appointment_unique UNIQUE (tenant_id, appointment_id),
    CONSTRAINT saga_instances_type CHECK (saga_type = 'appointment-booking'),
    CONSTRAINT saga_instances_patient_mode CHECK (patient_mode IN ('existing', 'create')),
    CONSTRAINT saga_instances_status CHECK (status IN (
        'started', 'awaiting_participants', 'confirming', 'completed', 'compensating', 'failed')),
    CONSTRAINT saga_instances_terminal_completed_at CHECK (
        (status IN ('completed', 'failed')) = (completed_at IS NOT NULL)),
    CONSTRAINT saga_instances_failed_has_error CHECK (status <> 'failed' OR error_code IS NOT NULL)
);

COMMENT ON TABLE saga_instances IS
    'Booking sagas (RF9, ADR-0006). Identifiers (appointment, new patient) are generated before dispatch so every participant is idempotent by id. New-patient PII is not stored here (it travels only in the EnsurePatientCommand outbox row).';
COMMENT ON COLUMN saga_instances.id IS 'Saga identifier; also the public operationId.';
COMMENT ON COLUMN saga_instances.appointment_id IS 'Appointment id pre-generated for HoldSlotCommand.';
COMMENT ON COLUMN saga_instances.patient_id IS 'Existing patient id, or the id pre-generated for a new patient.';
COMMENT ON COLUMN saga_instances.start_at IS 'Requested start instant; the end is derived by the scheduler from the service duration (I4).';
COMMENT ON COLUMN saga_instances.patient_mode IS 'existing: validate; create: register in the same operation.';
COMMENT ON COLUMN saga_instances.status IS
    'started → awaiting_participants → confirming → completed | compensating → failed.';
COMMENT ON COLUMN saga_instances.result IS 'Confirmed appointment returned by the operation resource.';
COMMENT ON COLUMN saga_instances.error_code IS 'Most specific business error (SLOT_TAKEN > PATIENT_OVERLAP > validation > not found > dependency).';
COMMENT ON COLUMN saga_instances.deadline_at IS 'After this instant the saga compensates (default 15 s).';

CREATE INDEX saga_instances_open_deadline_idx ON saga_instances (deadline_at)
    WHERE status NOT IN ('completed', 'failed');
COMMENT ON INDEX saga_instances_open_deadline_idx IS 'Sweeper: non-terminal sagas by deadline.';

CREATE TABLE saga_steps (
    tenant_id          uuid        NOT NULL,
    saga_id            uuid        NOT NULL,
    step_name          text        NOT NULL,
    status             text        NOT NULL DEFAULT 'pending',
    command_message_id uuid,
    attempts           integer     NOT NULL DEFAULT 0,
    last_attempt_at    timestamptz,
    next_attempt_at    timestamptz,
    result             jsonb,
    error_code         text,
    created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT saga_steps_pk PRIMARY KEY (saga_id, step_name),
    CONSTRAINT saga_steps_saga_fk FOREIGN KEY (tenant_id, saga_id) REFERENCES saga_instances (tenant_id, id),
    CONSTRAINT saga_steps_name CHECK (step_name IN ('patient', 'catalog', 'slot', 'confirm', 'release')),
    CONSTRAINT saga_steps_status CHECK (status IN (
        'pending', 'dispatched', 'succeeded', 'rejected', 'failed', 'compensating', 'compensated', 'skipped')),
    CONSTRAINT saga_steps_attempts_non_negative CHECK (attempts >= 0)
);

COMMENT ON TABLE saga_steps IS 'Booking saga steps: patient, catalog and slot run in parallel; confirm or release follow.';
COMMENT ON COLUMN saga_steps.command_message_id IS 'messageId of the command (outbox id), re-sent unchanged by the sweeper.';
COMMENT ON COLUMN saga_steps.result IS 'Persisted reply result (e.g. durationMinutes and serviceVersion from catalog and slot).';

CREATE TRIGGER saga_instances_touch_updated_at BEFORE UPDATE ON saga_instances
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER saga_steps_touch_updated_at BEFORE UPDATE ON saga_steps
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Wake HTTP handlers waiting for a terminal state (any replica may finalize the saga).
CREATE OR REPLACE FUNCTION saga_instances_notify_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IN ('completed', 'failed') AND OLD.status IS DISTINCT FROM NEW.status THEN
        PERFORM pg_notify('saga_terminal', NEW.id::text);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER saga_instances_notify_terminal AFTER UPDATE OF status ON saga_instances
    FOR EACH ROW EXECUTE FUNCTION saga_instances_notify_terminal();

ALTER TABLE saga_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE saga_instances FORCE ROW LEVEL SECURITY;
ALTER TABLE saga_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE saga_steps FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON saga_instances
    USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_isolation ON saga_steps
    USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY worker_discovery ON saga_instances FOR SELECT TO ${rolePrefix}_worker USING (true);
CREATE POLICY worker_discovery ON saga_steps FOR SELECT TO ${rolePrefix}_worker USING (true);

GRANT SELECT, INSERT ON saga_instances, saga_steps TO ${rolePrefix}_clinic_admin, ${rolePrefix}_receptionist;
GRANT SELECT, INSERT, UPDATE ON saga_instances, saga_steps TO ${rolePrefix}_system;
GRANT SELECT (id, tenant_id, status, deadline_at) ON saga_instances TO ${rolePrefix}_worker;
GRANT SELECT (tenant_id, saga_id, step_name, status, next_attempt_at) ON saga_steps TO ${rolePrefix}_worker;
GRANT SELECT ON saga_instances, saga_steps TO ${rolePrefix}_readonly;
