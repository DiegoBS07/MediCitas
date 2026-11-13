-- =============================================================================
-- Engine-level security verification for medicitas_user, as the runtime login:
--   psql -h postgres -U um_app -d medicitas_user -f verify-user-security.sql
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on

-- U1 — a professional reads patients but cannot register them (matrix RF14: read only).
BEGIN;
SET LOCAL ROLE um_professional;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true) \gset
DO $$
DECLARE v bigint;
BEGIN
    SELECT count(*) INTO v FROM patients;
    BEGIN
        INSERT INTO patients (id, tenant_id, identification_type, identification_number, first_name, last_name,
                              birth_date, created_by_subject)
        VALUES (gen_random_uuid(), '10000000-0000-4000-8000-000000000001', 'national_id', '9-9999-9999',
                'Test', 'Patient', DATE '1990-01-01', gen_random_uuid());
        RAISE EXCEPTION 'FAIL U1: professional inserted a patient';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'PASS U1 professional reads % patients and cannot insert', v;
END $$;
ROLLBACK;

-- U2 — patients of another clinic are invisible, even by explicit id.
BEGIN;
SET LOCAL ROLE um_receptionist;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true) \gset
DO $$
DECLARE v bigint;
BEGIN
    SELECT count(*) INTO v FROM patients WHERE id = '50000000-0000-4000-8000-000200000001';
    IF v <> 0 THEN RAISE EXCEPTION 'FAIL U2: foreign patient visible'; END IF;
    RAISE NOTICE 'PASS U2 patient of clinic 2 not visible from clinic 1 by id';
END $$;
ROLLBACK;

-- U3 — the last active clinic admin cannot be demoted (users_last_clinic_admin).
BEGIN;
SET LOCAL ROLE um_system;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true) \gset
DO $$
DECLARE v_constraint text;
BEGIN
    UPDATE users SET role = 'receptionist' WHERE id = '20000000-0000-4000-8000-000000010001';
    RAISE EXCEPTION 'FAIL U3: last clinic admin demoted';
EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE NOTICE 'PASS U3 demoting the last clinic admin -> %', v_constraint;
END $$;
ROLLBACK;

-- U4 — receptionists cannot read the users table (users:manage is clinic_admin only).
BEGIN;
SET LOCAL ROLE um_receptionist;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true) \gset
DO $$
BEGIN
    PERFORM 1 FROM users LIMIT 1;
    RAISE EXCEPTION 'FAIL U4: receptionist read users';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS U4 receptionist -> users permission denied';
END $$;
ROLLBACK;
