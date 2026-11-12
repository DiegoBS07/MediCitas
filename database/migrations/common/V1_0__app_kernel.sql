-- =============================================================================
-- Shared persistence kernel, applied to every service database.
-- Placeholders: ${rolePrefix}, ${schema}, ${tenantScoped}.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;

GRANT USAGE ON SCHEMA app, ${schema} TO ${rolePrefix}_actor, ${rolePrefix}_worker, ${rolePrefix}_readonly;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${rolePrefix}_bench_norls') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA app, ${schema} TO ${rolePrefix}_bench_norls';
    END IF;
END;
$$;

COMMENT ON SCHEMA app IS 'Shared helper functions: tenant/actor context accessors and generic triggers.';

-- -----------------------------------------------------------------------------
-- Request context (set per transaction with set_config(..., true); ADR-0004)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

COMMENT ON FUNCTION app.current_tenant_id() IS
    'Tenant of the current transaction (app.tenant_id). NULL when absent, so RLS predicates match no rows; a malformed value aborts the transaction.';

CREATE OR REPLACE FUNCTION app.current_actor_subject() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.actor_subject', true), '')::uuid $$;

COMMENT ON FUNCTION app.current_actor_subject() IS
    'Keycloak subject of the actor of the current transaction (app.actor_subject), or NULL.';

-- -----------------------------------------------------------------------------
-- Generic triggers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.touch_updated_at() IS 'BEFORE UPDATE trigger: maintains updated_at with the database clock.';

CREATE OR REPLACE FUNCTION app.reject_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% on %.% is not allowed: the table is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

COMMENT ON FUNCTION app.reject_modification() IS
    'Trigger that rejects UPDATE/DELETE/TRUNCATE on append-only tables (I6, RF15). Applies to every role, including the owner, unless a controlled maintenance migration disables it.';

GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_actor_subject()
    TO ${rolePrefix}_actor, ${rolePrefix}_worker, ${rolePrefix}_readonly;
