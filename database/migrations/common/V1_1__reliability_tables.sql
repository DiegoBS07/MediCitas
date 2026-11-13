-- =============================================================================
-- Reliability tables shared by every service:
--   outbox_messages      transactional outbox
--   inbox_messages       consumer de-duplication + stored replies
--   idempotency_records  HTTP Idempotency-Key records
-- tenant_id may be NULL only in control-plane databases (${tenantScoped} = false).
-- Policies use IS NOT DISTINCT FROM so that a NULL tenant row is only visible
-- to a transaction without tenant context (control plane).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Outbox
-- -----------------------------------------------------------------------------
CREATE TABLE outbox_messages (
    id              uuid        PRIMARY KEY,
    tenant_id       uuid,
    exchange        text        NOT NULL,
    routing_key     text        NOT NULL,
    message_type    text        NOT NULL,
    envelope        jsonb       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    available_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
    published_at    timestamptz,
    attempts        integer     NOT NULL DEFAULT 0,
    last_error      text,
    CONSTRAINT outbox_messages_tenant_required CHECK (NOT ${tenantScoped} OR tenant_id IS NOT NULL),
    CONSTRAINT outbox_messages_exchange_known CHECK (exchange IN (
        'medicitas.commands', 'medicitas.queries', 'medicitas.replies', 'medicitas.domain-events')),
    CONSTRAINT outbox_messages_routing_key_format CHECK (routing_key ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*$'),
    CONSTRAINT outbox_messages_envelope_id_matches CHECK (envelope ->> 'messageId' = id::text),
    CONSTRAINT outbox_messages_attempts_non_negative CHECK (attempts >= 0)
);

COMMENT ON TABLE outbox_messages IS
    'Transactional outbox: messages inserted in the same transaction as the state change they announce; published by the relay after a publisher confirm.';
COMMENT ON COLUMN outbox_messages.id IS 'Equals envelope.messageId (de-duplication key for consumers).';
COMMENT ON COLUMN outbox_messages.tenant_id IS 'Tenant of the message (NULL only for control-plane platform messages).';
COMMENT ON COLUMN outbox_messages.exchange IS 'Target RabbitMQ exchange.';
COMMENT ON COLUMN outbox_messages.routing_key IS 'Routing key used when publishing.';
COMMENT ON COLUMN outbox_messages.message_type IS 'Envelope messageType (duplicated for operational queries).';
COMMENT ON COLUMN outbox_messages.envelope IS 'Complete versioned envelope as published.';
COMMENT ON COLUMN outbox_messages.available_at IS 'Earliest publish time (back-off after a failed publish, or a scheduled re-send).';
COMMENT ON COLUMN outbox_messages.published_at IS 'Set only after the broker publisher confirm; NULL means pending.';
COMMENT ON COLUMN outbox_messages.attempts IS 'Publish attempts so far.';
COMMENT ON COLUMN outbox_messages.last_error IS 'Last publish error (technical message, no payload data).';

CREATE INDEX outbox_messages_pending_idx ON outbox_messages (available_at) WHERE published_at IS NULL;
COMMENT ON INDEX outbox_messages_pending_idx IS 'Relay claim query: pending rows ordered by availability (FOR UPDATE SKIP LOCKED).';

CREATE OR REPLACE FUNCTION app.notify_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('outbox_new', '');
    RETURN NULL;
END;
$$;

CREATE TRIGGER outbox_messages_notify
    AFTER INSERT ON outbox_messages
    FOR EACH STATEMENT EXECUTE FUNCTION app.notify_outbox();

ALTER TABLE outbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_messages FORCE ROW LEVEL SECURITY;

CREATE POLICY outbox_actor_insert ON outbox_messages
    FOR INSERT TO ${rolePrefix}_actor
    WITH CHECK (tenant_id IS NOT DISTINCT FROM app.current_tenant_id());

CREATE POLICY outbox_worker_all ON outbox_messages
    FOR ALL TO ${rolePrefix}_worker
    USING (true) WITH CHECK (true);

GRANT INSERT ON outbox_messages TO ${rolePrefix}_actor;
GRANT SELECT, DELETE, UPDATE (available_at, published_at, attempts, last_error)
    ON outbox_messages TO ${rolePrefix}_worker;

-- -----------------------------------------------------------------------------
-- Inbox
-- -----------------------------------------------------------------------------
CREATE TABLE inbox_messages (
    consumer        text        NOT NULL,
    message_id      uuid        NOT NULL,
    tenant_id       uuid,
    message_type    text        NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    reply_envelope  jsonb,
    CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer, message_id),
    CONSTRAINT inbox_messages_tenant_required CHECK (NOT ${tenantScoped} OR tenant_id IS NOT NULL)
);

COMMENT ON TABLE inbox_messages IS
    'Consumer de-duplication: one row per (consumer queue, messageId), inserted in the same transaction as the effects.';
COMMENT ON COLUMN inbox_messages.consumer IS 'Logical consumer (queue name).';
COMMENT ON COLUMN inbox_messages.message_id IS 'Envelope messageId of the processed message.';
COMMENT ON COLUMN inbox_messages.tenant_id IS 'Tenant of the processed message.';
COMMENT ON COLUMN inbox_messages.message_type IS 'Envelope messageType.';
COMMENT ON COLUMN inbox_messages.received_at IS 'Processing time (database clock).';
COMMENT ON COLUMN inbox_messages.reply_envelope IS 'Reply produced for a command, re-published verbatim on duplicate delivery.';

CREATE INDEX inbox_messages_received_at_idx ON inbox_messages (received_at);
COMMENT ON INDEX inbox_messages_received_at_idx IS 'Retention clean-up by age.';

ALTER TABLE inbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_messages FORCE ROW LEVEL SECURITY;

CREATE POLICY inbox_actor_tenant ON inbox_messages
    FOR ALL TO ${rolePrefix}_actor
    USING (tenant_id IS NOT DISTINCT FROM app.current_tenant_id())
    WITH CHECK (tenant_id IS NOT DISTINCT FROM app.current_tenant_id());

CREATE POLICY inbox_worker_cleanup ON inbox_messages
    FOR ALL TO ${rolePrefix}_worker
    USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE (reply_envelope) ON inbox_messages TO ${rolePrefix}_actor;
GRANT SELECT, DELETE ON inbox_messages TO ${rolePrefix}_worker;

-- -----------------------------------------------------------------------------
-- HTTP idempotency records
-- -----------------------------------------------------------------------------
CREATE TABLE idempotency_records (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid,
    http_method      text        NOT NULL,
    route_template   text        NOT NULL,
    idempotency_key  text        NOT NULL,
    request_hash     text        NOT NULL,
    status           text        NOT NULL DEFAULT 'in_progress',
    operation_id     uuid,
    response_status  integer,
    response_body    jsonb,
    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at       timestamptz NOT NULL DEFAULT clock_timestamp() + interval '24 hours',
    CONSTRAINT idempotency_records_scope_unique
        UNIQUE NULLS NOT DISTINCT (tenant_id, http_method, route_template, idempotency_key),
    CONSTRAINT idempotency_records_tenant_required CHECK (NOT ${tenantScoped} OR tenant_id IS NOT NULL),
    CONSTRAINT idempotency_records_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
    CONSTRAINT idempotency_records_method CHECK (http_method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
    CONSTRAINT idempotency_records_status CHECK (status IN ('in_progress', 'completed')),
    CONSTRAINT idempotency_records_completed_has_response CHECK (
        status = 'in_progress' OR (response_status BETWEEN 200 AND 599 AND response_body IS NOT NULL))
);

COMMENT ON TABLE idempotency_records IS
    'Idempotency-Key records: replay of the stored response for the same key and body; 422 for the same key with a different body. Retained 24 h.';
COMMENT ON COLUMN idempotency_records.tenant_id IS 'Scope: the caller tenant, or NULL for platform-scoped requests.';
COMMENT ON COLUMN idempotency_records.route_template IS 'Express route template, e.g. /api/v1/appointments/:appointmentId/cancel.';
COMMENT ON COLUMN idempotency_records.request_hash IS 'SHA-256 of the canonical JSON request body.';
COMMENT ON COLUMN idempotency_records.status IS 'in_progress while the first request runs; completed once the response is stored.';
COMMENT ON COLUMN idempotency_records.operation_id IS 'Saga/operation identifier for long-running requests (202 Location).';
COMMENT ON COLUMN idempotency_records.response_status IS 'Stored HTTP status of the first completed response.';
COMMENT ON COLUMN idempotency_records.response_body IS 'Stored response body (problem+json or data).';
COMMENT ON COLUMN idempotency_records.expires_at IS 'Retention limit; expired rows are deleted by the worker.';

CREATE INDEX idempotency_records_expires_at_idx ON idempotency_records (expires_at);
COMMENT ON INDEX idempotency_records_expires_at_idx IS 'Retention clean-up by expiry.';

ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;

CREATE POLICY idempotency_actor_tenant ON idempotency_records
    FOR ALL TO ${rolePrefix}_actor
    USING (tenant_id IS NOT DISTINCT FROM app.current_tenant_id())
    WITH CHECK (tenant_id IS NOT DISTINCT FROM app.current_tenant_id());

CREATE POLICY idempotency_worker_cleanup ON idempotency_records
    FOR ALL TO ${rolePrefix}_worker
    USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE (status, operation_id, response_status, response_body)
    ON idempotency_records TO ${rolePrefix}_actor;
GRANT SELECT (id, expires_at), DELETE ON idempotency_records TO ${rolePrefix}_worker;
