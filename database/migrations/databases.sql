-- =============================================================================
-- MediCitas — databases, connection privileges, search paths and extensions.
-- Idempotent. Executed by database/bootstrap.sh as superuser, after roles.sql.
-- One PostgreSQL instance, one database per service (ADR-0010).
-- =============================================================================
\set ON_ERROR_STOP on

CREATE TEMP TABLE service_databases (
    db_name     text PRIMARY KEY,
    prefix      text NOT NULL,
    schema_name text NOT NULL,
    has_bench   boolean NOT NULL
);

INSERT INTO service_databases VALUES
    ('medicitas_tenant',                   'tm',  'tenancy',      false),
    ('medicitas_onboarding',               'onb', 'onboarding',   false),
    ('medicitas_user',                     'um',  'identity',     true),
    ('medicitas_user_orchestrator',        'umo', 'provisioning', false),
    ('medicitas_catalog',                  'cat', 'catalog',      true),
    ('medicitas_scheduler',                'sch', 'scheduling',   true),
    ('medicitas_appointment_orchestrator', 'ao',  'booking',      false);

-- CREATE DATABASE cannot run inside a function or transaction block: use \gexec.
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', db_name, prefix || '_owner')
FROM service_databases d
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = d.db_name) \gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', db_name, prefix || '_owner') FROM service_databases \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', db_name) FROM service_databases \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I, %I', db_name, prefix || '_app', prefix || '_readonly')
FROM service_databases \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', db_name, prefix || '_bench_norls')
FROM service_databases WHERE has_bench \gexec

-- Runtime and evidence roles resolve unqualified names in the service schema, then app.
SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = %I, app', r.role_name, d.db_name, d.schema_name)
FROM service_databases d
CROSS JOIN LATERAL (
    VALUES (d.prefix || '_app'), (d.prefix || '_readonly'), (d.prefix || '_bench_norls')
) AS r(role_name)
WHERE r.role_name <> d.prefix || '_bench_norls' OR d.has_bench \gexec

-- Per-database hardening and extensions (requires connecting to each database).
\connect medicitas_tenant
REVOKE ALL ON SCHEMA public FROM PUBLIC;
\connect medicitas_onboarding
REVOKE ALL ON SCHEMA public FROM PUBLIC;
\connect medicitas_user
REVOKE ALL ON SCHEMA public FROM PUBLIC;
\connect medicitas_user_orchestrator
REVOKE ALL ON SCHEMA public FROM PUBLIC;
\connect medicitas_catalog
REVOKE ALL ON SCHEMA public FROM PUBLIC;
\connect medicitas_appointment_orchestrator
REVOKE ALL ON SCHEMA public FROM PUBLIC;
\connect medicitas_scheduler
REVOKE ALL ON SCHEMA public FROM PUBLIC;
-- btree_gist: equality (=) operators for uuid/int inside GiST exclusion constraints (I1, I2, RF5).
-- Installed in schema public; the operator classes are found by type, not by search_path.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
