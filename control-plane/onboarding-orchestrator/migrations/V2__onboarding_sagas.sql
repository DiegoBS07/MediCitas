-- =============================================================================
-- onboarding-orchestrator (database medicitas_onboarding, schema onboarding) — RF1
-- Persisted saga state (ADR-0012). Platform-scoped: no tenant RLS.
-- =============================================================================

CREATE TABLE saga_instances (
    id                uuid        PRIMARY KEY,
    saga_type         text        NOT NULL DEFAULT 'tenant-onboarding',
    tenant_id         uuid,
    status            text        NOT NULL DEFAULT 'started',
    request           jsonb       NOT NULL,
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
    CONSTRAINT saga_instances_type CHECK (saga_type = 'tenant-onboarding'),
    CONSTRAINT saga_instances_status CHECK (status IN (
        'started', 'tenant_created', 'identity_provisioned', 'activating',
        'completed', 'compensating', 'failed')),
    CONSTRAINT saga_instances_terminal_completed_at CHECK (
        (status IN ('completed', 'failed')) = (completed_at IS NOT NULL)),
    CONSTRAINT saga_instances_failed_has_error CHECK (status <> 'failed' OR error_code IS NOT NULL),
    CONSTRAINT saga_instances_request_has_no_password CHECK (
        request -> 'temporaryPassword' IS NULL
        AND request -> 'firstAdmin' -> 'temporaryPassword' IS NULL)
);

COMMENT ON TABLE saga_instances IS 'Onboarding saga instances (RF1). The temporary password of the first admin is never stored.';
COMMENT ON COLUMN saga_instances.id IS 'Saga identifier; also the public operationId.';
COMMENT ON COLUMN saga_instances.tenant_id IS 'Tenant created by the saga (known after TenantCreatedReply).';
COMMENT ON COLUMN saga_instances.status IS 'State machine: started → tenant_created → identity_provisioned → activating → completed | compensating → failed.';
COMMENT ON COLUMN saga_instances.request IS 'Minimized request snapshot (name, slug, timezone, first admin identity; no password).';
COMMENT ON COLUMN saga_instances.result IS 'Terminal result returned by the operation resource.';
COMMENT ON COLUMN saga_instances.error_code IS 'Stable error code of a failed saga.';
COMMENT ON COLUMN saga_instances.actor_subject IS 'Keycloak subject of the platform admin who started the saga.';
COMMENT ON COLUMN saga_instances.correlation_id IS 'Correlation identifier of the originating HTTP request.';
COMMENT ON COLUMN saga_instances.deadline_at IS 'After this instant the sweeper compensates a non-terminal saga.';
COMMENT ON COLUMN saga_instances.version IS 'Optimistic version incremented on each state change.';

CREATE INDEX saga_instances_open_deadline_idx ON saga_instances (deadline_at)
    WHERE status NOT IN ('completed', 'failed');
COMMENT ON INDEX saga_instances_open_deadline_idx IS 'Sweeper: non-terminal sagas by deadline.';

CREATE TABLE saga_steps (
    saga_id            uuid        NOT NULL REFERENCES saga_instances (id),
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
    CONSTRAINT saga_steps_name CHECK (step_name IN (
        'create_tenant', 'keycloak_group', 'keycloak_admin_user', 'activate_tenant', 'mark_tenant_failed')),
    CONSTRAINT saga_steps_status CHECK (status IN (
        'pending', 'dispatched', 'succeeded', 'rejected', 'failed', 'compensating', 'compensated', 'skipped')),
    CONSTRAINT saga_steps_attempts_non_negative CHECK (attempts >= 0)
);

COMMENT ON TABLE saga_steps IS 'One row per saga step: dispatch, retries and the persisted reply.';
COMMENT ON COLUMN saga_steps.command_message_id IS 'messageId of the command (re-sent with the same id for idempotency).';
COMMENT ON COLUMN saga_steps.result IS 'Reply result or Keycloak artifact ids, including createdBySaga flags used by compensation.';

CREATE TRIGGER saga_instances_touch_updated_at BEFORE UPDATE ON saga_instances
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER saga_steps_touch_updated_at BEFORE UPDATE ON saga_steps
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

GRANT SELECT, INSERT ON saga_instances, saga_steps TO ${rolePrefix}_platform_admin;
GRANT SELECT, INSERT, UPDATE ON saga_instances, saga_steps TO ${rolePrefix}_system;
GRANT SELECT (id, status, deadline_at) ON saga_instances TO ${rolePrefix}_worker;
GRANT SELECT (saga_id, step_name, status, next_attempt_at) ON saga_steps TO ${rolePrefix}_worker;
GRANT SELECT ON saga_instances, saga_steps TO ${rolePrefix}_readonly;
