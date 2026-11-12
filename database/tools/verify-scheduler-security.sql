-- =============================================================================
-- Stage 2 engine-level verification for medicitas_scheduler.
-- Connect as the RUNTIME login (sch_app), exactly as the service will:
--   psql -h postgres -U sch_app -d medicitas_scheduler -f verify-scheduler-security.sql
-- Every check prints "PASS ..." or aborts the script with "FAIL ...".
-- Every transaction is rolled back: the script leaves no data behind.
-- The automated equivalents live in tests/ (Stage 6).
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on

-- C1 — the runtime login has no privileges of its own: forgetting SET ROLE fails closed.
DO $$
BEGIN
    PERFORM 1 FROM scheduling.appointments LIMIT 1;
    RAISE EXCEPTION 'FAIL C1: sch_app read appointments without SET ROLE';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS C1 runtime login without SET ROLE is denied';
END $$;

-- C2 — RLS with no tenant context: zero rows (absence of context is rejected).
BEGIN;
SET LOCAL ROLE sch_receptionist;
DO $$
DECLARE v bigint;
BEGIN
    SELECT count(*) INTO v FROM appointments;
    IF v <> 0 THEN RAISE EXCEPTION 'FAIL C2: % rows visible without tenant context', v; END IF;
    RAISE NOTICE 'PASS C2 no tenant context -> 0 appointments visible';
END $$;
ROLLBACK;

-- C3 — tenant 1 context: rows visible, none of tenant 2 even when explicitly requested.
BEGIN;
SET LOCAL ROLE sch_receptionist;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true) \gset
DO $$
DECLARE v_own bigint; v_foreign bigint; v_other_ids bigint;
BEGIN
    SELECT count(*) INTO v_own FROM appointments;
    SELECT count(*) INTO v_foreign FROM appointments WHERE tenant_id = '10000000-0000-4000-8000-000000000002';
    SELECT count(*) INTO v_other_ids FROM appointments WHERE tenant_id <> '10000000-0000-4000-8000-000000000001';
    IF v_own = 0 THEN RAISE EXCEPTION 'FAIL C3: tenant 1 sees no appointments (seed missing?)'; END IF;
    IF v_foreign <> 0 OR v_other_ids <> 0 THEN RAISE EXCEPTION 'FAIL C3: foreign rows visible'; END IF;
    RAISE NOTICE 'PASS C3 tenant 1 sees % own appointments and 0 of tenant 2 (manipulated filter ignored by RLS)', v_own;
END $$;
ROLLBACK;

-- C4 — receptionist cannot read clinical notes (matrix: notes only for the professional).
BEGIN;
SET LOCAL ROLE sch_receptionist;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true) \gset
DO $$
BEGIN
    PERFORM 1 FROM clinical_notes LIMIT 1;
    RAISE EXCEPTION 'FAIL C4: receptionist read clinical_notes';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS C4 receptionist -> clinical_notes permission denied';
END $$;
ROLLBACK;

-- C5 — I6: the application cannot modify or delete the audit log (even the clinic admin).
BEGIN;
SET LOCAL ROLE sch_clinic_admin;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true) \gset
DO $$
BEGIN
    BEGIN
        UPDATE audit_log SET outcome = 'denied';
        RAISE EXCEPTION 'FAIL C5: audit_log UPDATE allowed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        DELETE FROM audit_log;
        RAISE EXCEPTION 'FAIL C5: audit_log DELETE allowed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'PASS C5 audit_log UPDATE/DELETE denied to the application (I6)';
END $$;
ROLLBACK;

-- C6 — I1: an overlapping hold for a busy professional is rejected by the exclusion constraint.
BEGIN;
SET LOCAL ROLE sch_system;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true) \gset
DO $$
DECLARE r record; v_constraint text;
BEGIN
    SELECT a.* INTO r FROM appointments a
    WHERE a.status = 'booked' AND lower(a.slot) > now()
      AND NOT EXISTS (SELECT 1 FROM calendar_blocks cb WHERE cb.tenant_id = a.tenant_id
                      AND cb.professional_id = a.professional_id AND cb.status = 'active' AND cb.period && a.slot)
    ORDER BY lower(a.slot) LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'FAIL C6: no future booked appointment in seed'; END IF;
    BEGIN
        INSERT INTO appointments (id, tenant_id, patient_id, professional_id, service_id, slot, status,
                                  hold_expires_at, booked_by_subject)
        VALUES (gen_random_uuid(), r.tenant_id, gen_random_uuid(), r.professional_id, r.service_id, r.slot,
                'held', now() + interval '60 seconds', gen_random_uuid());
        RAISE EXCEPTION 'FAIL C6: overlapping hold accepted';
    EXCEPTION WHEN exclusion_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint <> 'appointments_no_professional_overlap' THEN
            RAISE EXCEPTION 'FAIL C6: unexpected constraint %', v_constraint;
        END IF;
    END;
    RAISE NOTICE 'PASS C6 overlapping hold -> 23P01 appointments_no_professional_overlap (I1)';
END $$;
ROLLBACK;

-- C7 — I2: the same patient cannot hold two overlapping slots with different professionals.
BEGIN;
SET LOCAL ROLE sch_system;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true) \gset
DO $$
DECLARE r record; v_free record; v_constraint text;
BEGIN
    -- A free slot of professional 2 (pediatric consultation, 30 min) in the next days.
    SELECT s.start_at, s.end_at, d INTO v_free
    FROM generate_series(1, 14) AS d,
         LATERAL compute_available_slots('42000000-0000-4000-8000-000000010002',
                                         '41000000-0000-4000-8000-000000010003',
                                         (now() AT TIME ZONE 'America/Costa_Rica')::date + d) s
    ORDER BY d, s.start_at LIMIT 1;
    INSERT INTO appointments (id, tenant_id, patient_id, professional_id, service_id, slot, status,
                              hold_expires_at, booked_by_subject)
    VALUES (gen_random_uuid(), '10000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000100000077',
            '42000000-0000-4000-8000-000000010002', '41000000-0000-4000-8000-000000010003',
            tstzrange(v_free.start_at, v_free.end_at, '[)'), 'held', now() + interval '60 seconds', gen_random_uuid());
    -- Same patient, professional 1, a slot overlapping the first one, if professional 1 is free then.
    SELECT s.start_at, s.end_at INTO r
    FROM compute_available_slots('42000000-0000-4000-8000-000000010001', '41000000-0000-4000-8000-000000010002',
                                 (v_free.start_at AT TIME ZONE 'America/Costa_Rica')::date) s
    WHERE tstzrange(s.start_at, s.end_at, '[)') && tstzrange(v_free.start_at, v_free.end_at, '[)')
    LIMIT 1;
    IF NOT FOUND THEN
        RAISE NOTICE 'SKIP C7 no overlapping free slot for professional 1 on that day';
        RETURN;
    END IF;
    BEGIN
        INSERT INTO appointments (id, tenant_id, patient_id, professional_id, service_id, slot, status,
                                  hold_expires_at, booked_by_subject)
        VALUES (gen_random_uuid(), '10000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000100000077',
                '42000000-0000-4000-8000-000000010001', '41000000-0000-4000-8000-000000010002',
                tstzrange(r.start_at, r.end_at, '[)'), 'held', now() + interval '60 seconds', gen_random_uuid());
        RAISE EXCEPTION 'FAIL C7: patient double-booked';
    EXCEPTION WHEN exclusion_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint <> 'appointments_no_patient_overlap' THEN
            RAISE EXCEPTION 'FAIL C7: unexpected constraint %', v_constraint;
        END IF;
    END;
    RAISE NOTICE 'PASS C7 patient overlap across professionals -> 23P01 appointments_no_patient_overlap (I2)';
END $$;
ROLLBACK;

-- C8 — I3/I4 rules inside the engine: wrong duration, outside hours, misaligned start.
BEGIN;
SET LOCAL ROLE sch_system;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true) \gset
DO $$
DECLARE v_free record; v_constraint text; v_case text;
BEGIN
    SELECT s.start_at, s.end_at INTO v_free
    FROM generate_series(1, 14) AS d,
         LATERAL compute_available_slots('42000000-0000-4000-8000-000000010001',
                                         '41000000-0000-4000-8000-000000010001',
                                         (now() AT TIME ZONE 'America/Costa_Rica')::date + d) s
    ORDER BY d, s.start_at LIMIT 1;

    FOREACH v_case IN ARRAY ARRAY['duration', 'hours', 'grid'] LOOP
        BEGIN
            INSERT INTO appointments (id, tenant_id, patient_id, professional_id, service_id, slot, status,
                                      hold_expires_at, booked_by_subject)
            VALUES (gen_random_uuid(), '10000000-0000-4000-8000-000000000001', gen_random_uuid(),
                    '42000000-0000-4000-8000-000000010001', '41000000-0000-4000-8000-000000010001',
                    CASE v_case
                        WHEN 'duration' THEN tstzrange(v_free.start_at, v_free.start_at + interval '45 minutes', '[)')
                        WHEN 'hours'    THEN tstzrange(date_trunc('day', v_free.start_at) + interval '3 hours',
                                                       date_trunc('day', v_free.start_at) + interval '3 hours 30 minutes', '[)')
                        ELSE                 tstzrange(v_free.start_at + interval '5 minutes',
                                                       v_free.end_at + interval '5 minutes', '[)')
                    END,
                    'held', now() + interval '60 seconds', gen_random_uuid());
            RAISE EXCEPTION 'FAIL C8: % case accepted', v_case;
        EXCEPTION WHEN check_violation THEN
            GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
            RAISE NOTICE 'PASS C8 % -> %', v_case, v_constraint;
        END;
    END LOOP;
END $$;
ROLLBACK;

-- C9 — RF13: invalid transition (attended -> booked) and RF12 outcome before start.
BEGIN;
SET LOCAL ROLE sch_receptionist;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true) \gset
DO $$
DECLARE v_constraint text; v_id uuid;
BEGIN
    SELECT id INTO v_id FROM appointments WHERE status = 'attended' LIMIT 1;
    BEGIN
        UPDATE appointments SET status = 'booked' WHERE id = v_id;
        RAISE EXCEPTION 'FAIL C9: attended -> booked accepted';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        RAISE NOTICE 'PASS C9a attended -> booked -> %', v_constraint;
    END;
    SELECT id INTO v_id FROM appointments WHERE status = 'booked' AND lower(slot) > now() + interval '1 hour' LIMIT 1;
    BEGIN
        UPDATE appointments
        SET status = 'attended', outcome_recorded_by_subject = gen_random_uuid(), outcome_recorded_at = now()
        WHERE id = v_id;
        RAISE EXCEPTION 'FAIL C9: outcome before start accepted';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        RAISE NOTICE 'PASS C9b outcome before start -> %', v_constraint;
    END;
END $$;
ROLLBACK;

-- C10 — a professional only sees the notes they authored (restrictive RLS).
BEGIN;
SET LOCAL ROLE sch_professional;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true),
       set_config('app.actor_subject', '30000000-0000-4000-8000-000000010011', true) \gset
DO $$
DECLARE v_total bigint; v_foreign bigint;
BEGIN
    SELECT count(*), count(*) FILTER (WHERE author_subject <> '30000000-0000-4000-8000-000000010011')
    INTO v_total, v_foreign FROM clinical_notes;
    IF v_foreign <> 0 THEN RAISE EXCEPTION 'FAIL C10: % foreign notes visible', v_foreign; END IF;
    RAISE NOTICE 'PASS C10 professional sees % own notes and 0 of colleagues', v_total;
END $$;
ROLLBACK;

-- C11 — WITH CHECK: a tenant-1 transaction cannot write a tenant-2 row.
BEGIN;
SET LOCAL ROLE sch_clinic_admin;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true) \gset
DO $$
BEGIN
    INSERT INTO audit_log (tenant_id, occurred_at, actor_subject, actor_role, patient_id, resource_type,
                           resource_id, action, outcome, correlation_id, source_service)
    VALUES ('10000000-0000-4000-8000-000000000002', now(), gen_random_uuid(), 'clinic_admin', gen_random_uuid(),
            'patient_contact', gen_random_uuid(), 'read', 'success', gen_random_uuid(), 'scheduler-management');
    RAISE EXCEPTION 'FAIL C11: cross-tenant insert accepted';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS C11 cross-tenant write rejected by RLS WITH CHECK';
END $$;
ROLLBACK;

-- C12 — the platform administrator has no role in this database.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'sch\_platform%') THEN
        RAISE EXCEPTION 'FAIL C12: a platform role exists in the scheduler database';
    END IF;
    RAISE NOTICE 'PASS C12 no platform-admin role in medicitas_scheduler';
END $$;
