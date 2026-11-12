-- =============================================================================
-- MediCitas — cluster-level roles (idempotent).
-- Executed by database/bootstrap.sh as the PostgreSQL superuser, BEFORE Flyway.
-- Passwords arrive as psql variables (never stored in the repository).
--
-- Per service database (prefix p):
--   p_owner       LOGIN, BYPASSRLS   Flyway only: owns every object, runs migrations and seeds.
--   p_app         LOGIN, NOINHERIT   Runtime connection. No privileges of its own; it may only
--                                    SET ROLE to the actor roles and the worker role.
--   p_actor       NOLOGIN            Group role: privileges shared by every actor role
--                                    (outbox, inbox, idempotency, audit inserts, ...).
--   p_<actor>     NOLOGIN            One per permission-matrix profile (ADR-0009).
--   p_worker      NOLOGIN            Cross-tenant discovery for background loops (outbox relay,
--                                    saga sweeper, hold-expiry sweeper). Minimal column grants.
--   p_readonly    LOGIN              Evidence collection (EXPLAIN, test assertions); RLS applies.
--   p_bench_norls LOGIN, BYPASSRLS   Module 2 comparison only (tenant-scoped databases). SELECT only.
-- =============================================================================
\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.ensure_role(
    p_name      text,
    p_login     boolean,
    p_bypassrls boolean,
    p_inherit   boolean
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_name) THEN
        EXECUTE format('CREATE ROLE %I', p_name);
    END IF;
    EXECUTE format(
        'ALTER ROLE %I %s %s %s NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
        p_name,
        CASE WHEN p_login     THEN 'LOGIN'     ELSE 'NOLOGIN'     END,
        CASE WHEN p_bypassrls THEN 'BYPASSRLS' ELSE 'NOBYPASSRLS' END,
        CASE WHEN p_inherit   THEN 'INHERIT'   ELSE 'NOINHERIT'   END
    );
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.ensure_service_roles(
    p_prefix     text,
    p_actors     text[],
    p_with_bench boolean
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_actor text;
BEGIN
    PERFORM pg_temp.ensure_role(p_prefix || '_owner',    true,  true,  true);
    PERFORM pg_temp.ensure_role(p_prefix || '_app',      true,  false, false);
    PERFORM pg_temp.ensure_role(p_prefix || '_actor',    false, false, true);
    PERFORM pg_temp.ensure_role(p_prefix || '_worker',   false, false, true);
    PERFORM pg_temp.ensure_role(p_prefix || '_readonly', true,  false, true);
    IF p_with_bench THEN
        PERFORM pg_temp.ensure_role(p_prefix || '_bench_norls', true, true, true);
    END IF;

    FOREACH v_actor IN ARRAY p_actors LOOP
        PERFORM pg_temp.ensure_role(p_prefix || '_' || v_actor, false, false, true);
        -- Every actor inherits the shared actor privileges.
        EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET FALSE',
                       p_prefix || '_actor', p_prefix || '_' || v_actor);
        -- The runtime login may switch to the actor role per transaction, never inherit it.
        EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE',
                       p_prefix || '_' || v_actor, p_prefix || '_app');
    END LOOP;

    EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE',
                   p_prefix || '_worker', p_prefix || '_app');
END;
$$;

-- Control plane
SELECT pg_temp.ensure_service_roles('tm',  ARRAY['platform_admin', 'system'], false);
SELECT pg_temp.ensure_service_roles('onb', ARRAY['platform_admin', 'system'], false);
-- Application plane
SELECT pg_temp.ensure_service_roles('um',  ARRAY['clinic_admin', 'receptionist', 'professional', 'system'], true);
SELECT pg_temp.ensure_service_roles('umo', ARRAY['clinic_admin', 'system'], false);
SELECT pg_temp.ensure_service_roles('cat', ARRAY['clinic_admin', 'receptionist', 'professional', 'system'], true);
SELECT pg_temp.ensure_service_roles('sch', ARRAY['clinic_admin', 'receptionist', 'professional', 'system'], true);
SELECT pg_temp.ensure_service_roles('ao',  ARRAY['clinic_admin', 'receptionist', 'system'], false);

-- Passwords (re-applied on every run so .env changes take effect). %L quotes safely.
SELECT format('ALTER ROLE %I PASSWORD %L', 'tm_owner',  :'tm_owner_pw')  \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'tm_app',    :'tm_app_pw')    \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'onb_owner', :'onb_owner_pw') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'onb_app',   :'onb_app_pw')   \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'um_owner',  :'um_owner_pw')  \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'um_app',    :'um_app_pw')    \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'umo_owner', :'umo_owner_pw') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'umo_app',   :'umo_app_pw')   \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'cat_owner', :'cat_owner_pw') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'cat_app',   :'cat_app_pw')   \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'sch_owner', :'sch_owner_pw') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'sch_app',   :'sch_app_pw')   \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'ao_owner',  :'ao_owner_pw')  \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', 'ao_app',    :'ao_app_pw')    \gexec

SELECT format('ALTER ROLE %I PASSWORD %L', r, :'evidence_pw')
FROM unnest(ARRAY['tm_readonly', 'onb_readonly', 'um_readonly', 'umo_readonly', 'cat_readonly',
                  'sch_readonly', 'ao_readonly', 'um_bench_norls', 'cat_bench_norls',
                  'sch_bench_norls']) AS r \gexec
