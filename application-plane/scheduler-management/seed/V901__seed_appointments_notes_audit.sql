-- =============================================================================
-- Demo seed (scheduler): appointments spread from 45 days ago to 21 days ahead,
-- clinical notes of attended appointments, audit entries, reschedule chains and
-- a calendar-block conflict example (RF6).
--
-- Slots are taken ONLY from compute_available_slots() (the RF7 definition), and
-- every row goes through the same constraints/triggers as production writes
-- (I1–I4). Overlaps produced by the generator are skipped with ON CONFLICT DO
-- NOTHING (works with exclusion constraints). Density: ~1 of 4 grid points in
-- the past and next 7 days, ~1 of 8 further ahead, so free slots remain for demos.
-- Dates are relative to the migration time.
-- =============================================================================

DO $$
DECLARE
    r_tenant     record;
    r_prof       record;
    r_slot       record;
    v_today      date;
    v_day        integer;
    v_services   uuid[];
    v_service    uuid;
    v_index      integer;
    v_modulus    integer;
    v_k          integer;
    v_status     text;
    v_patient    uuid;
    v_recep_a    uuid;
    v_recep_b    uuid;
BEGIN
    FOR r_tenant IN
        SELECT t.id, t.timezone, row_number() OVER (ORDER BY t.id)::int AS n FROM tenants t ORDER BY t.id
    LOOP
        -- compute_available_slots() filters by app.current_tenant_id() (discriminator).
        PERFORM set_config('app.tenant_id', r_tenant.id::text, true);
        v_today   := (now() AT TIME ZONE r_tenant.timezone)::date;
        v_recep_a := ('30000000-0000-4000-8000-' || lpad(r_tenant.n::text, 8, '0') || '0002')::uuid;
        v_recep_b := ('30000000-0000-4000-8000-' || lpad(r_tenant.n::text, 8, '0') || '0003')::uuid;

        FOR r_prof IN
            SELECT p.id, row_number() OVER (ORDER BY p.id)::int AS n
            FROM catalog_professionals p WHERE p.tenant_id = r_tenant.id ORDER BY p.id
        LOOP
            SELECT array_agg(ps.service_id ORDER BY ps.service_id) INTO v_services
            FROM catalog_professional_services ps
            WHERE ps.tenant_id = r_tenant.id AND ps.professional_id = r_prof.id;

            FOR v_day IN -45 .. 21 LOOP
                v_service := v_services[1 + ((v_day + 100) % array_length(v_services, 1))];
                v_modulus := CASE WHEN v_day > 7 THEN 8 ELSE 4 END;
                v_index   := 0;

                FOR r_slot IN SELECT * FROM compute_available_slots(r_prof.id, v_service, v_today + v_day) LOOP
                    v_index := v_index + 1;
                    CONTINUE WHEN (v_index + v_day + 100 + r_prof.n) % v_modulus <> 0;

                    v_patient := ('50000000-0000-4000-8000-' || lpad(r_tenant.n::text, 4, '0')
                                  || lpad((((v_index * 7 + (v_day + 100) * 13 + r_prof.n * 31) % 119) + 1)::text, 8, '0'))::uuid;
                    v_k := (v_index + v_day + 100) % 20;

                    IF r_slot.start_at < now() THEN
                        v_status := CASE WHEN v_k < 15 THEN 'attended'
                                         WHEN v_k < 17 THEN 'no_show'
                                         WHEN v_k < 19 THEN 'cancelled'
                                         ELSE 'booked' END;
                    ELSE
                        v_status := CASE WHEN v_k % 10 = 0 THEN 'cancelled' ELSE 'booked' END;
                    END IF;

                    INSERT INTO appointments (
                        id, tenant_id, patient_id, professional_id, service_id, slot, status, booked_by_subject,
                        cancel_reason, cancelled_by_subject, cancelled_at,
                        outcome_recorded_by_subject, outcome_recorded_at, created_at)
                    VALUES (
                        gen_random_uuid(), r_tenant.id, v_patient, r_prof.id, v_service,
                        tstzrange(r_slot.start_at, r_slot.end_at, '[)'), v_status,
                        CASE WHEN v_index % 2 = 0 THEN v_recep_a ELSE v_recep_b END,
                        CASE WHEN v_status = 'cancelled'
                             THEN (ARRAY['Patient requested cancellation', 'Patient is travelling',
                                         'Patient reported feeling better'])[1 + v_index % 3] END,
                        CASE WHEN v_status = 'cancelled' THEN v_recep_b END,
                        CASE WHEN v_status = 'cancelled' THEN least(now(), r_slot.start_at - interval '1 day') END,
                        CASE WHEN v_status IN ('attended', 'no_show') THEN v_recep_a END,
                        CASE WHEN v_status IN ('attended', 'no_show') THEN least(now(), r_slot.end_at) END,
                        least(now(), r_slot.start_at - interval '3 days'))
                    ON CONFLICT DO NOTHING;
                END LOOP;
            END LOOP;
        END LOOP;
    END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- Reschedule chains (RF10): for each clinic, the 3 earliest future booked
-- appointments are moved one week later through the real transition path
-- (booked → rescheduled + successor row). Skipped when no free slot exists.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    r_tenant  record;
    r_appt    record;
    r_target  record;
BEGIN
    FOR r_tenant IN SELECT t.id, t.timezone FROM tenants t ORDER BY t.id LOOP
        PERFORM set_config('app.tenant_id', r_tenant.id::text, true);

        FOR r_appt IN
            SELECT a.* FROM appointments a
            WHERE a.tenant_id = r_tenant.id AND a.status = 'booked' AND lower(a.slot) > now() + interval '1 day'
            ORDER BY lower(a.slot), a.id
            LIMIT 3
        LOOP
            SELECT s.start_at, s.end_at INTO r_target
            FROM compute_available_slots(r_appt.professional_id, r_appt.service_id,
                                         (lower(r_appt.slot) AT TIME ZONE r_tenant.timezone)::date + 7) AS s
            ORDER BY s.start_at
            LIMIT 1;
            CONTINUE WHEN NOT FOUND;

            BEGIN
                UPDATE appointments SET status = 'rescheduled', version = version + 1
                WHERE tenant_id = r_appt.tenant_id AND id = r_appt.id;

                INSERT INTO appointments (id, tenant_id, patient_id, professional_id, service_id, slot, status,
                                          rescheduled_from_id, booked_by_subject)
                VALUES (gen_random_uuid(), r_appt.tenant_id, r_appt.patient_id, r_appt.professional_id,
                        r_appt.service_id, tstzrange(r_target.start_at, r_target.end_at, '[)'), 'booked',
                        r_appt.id, r_appt.booked_by_subject);
            EXCEPTION WHEN exclusion_violation THEN
                -- The patient is busy at the target time: the subtransaction is rolled back.
                NULL;
            END;
        END LOOP;
    END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- Clinical notes (RF15) for about one third of attended appointments, written by
-- the appointment professional, plus their audit entries (RF18).
-- -----------------------------------------------------------------------------
WITH notes AS (
    INSERT INTO clinical_notes (id, tenant_id, appointment_id, author_subject, content, created_at)
    SELECT gen_random_uuid(), a.tenant_id, a.id, p.keycloak_subject,
           (ARRAY['Synthetic seed note: patient reports improvement; continue current treatment.',
                  'Synthetic seed note: vital signs within normal ranges; follow-up in four weeks.',
                  'Synthetic seed note: findings discussed with the patient; written care plan provided.']
           )[(1 + abs(hashtext(a.id::text)::bigint) % 3)::int],
           least(now(), upper(a.slot) + interval '10 minutes')
    FROM appointments a
    JOIN catalog_professionals p ON p.tenant_id = a.tenant_id AND p.id = a.professional_id
    WHERE a.status = 'attended' AND abs(hashtext(a.id::text)::bigint) % 3 = 0
    RETURNING id, tenant_id, appointment_id, author_subject, created_at
)
INSERT INTO audit_log (tenant_id, occurred_at, actor_subject, actor_role, patient_id, resource_type,
                       resource_id, action, outcome, correlation_id, source_service)
SELECT n.tenant_id, n.created_at, n.author_subject, 'health_professional', a.patient_id, 'clinical_note',
       n.id, 'create', 'success', gen_random_uuid(), 'scheduler-management'
FROM notes n
JOIN appointments a ON a.tenant_id = n.tenant_id AND a.id = n.appointment_id;

-- Patient contact reads by reception (as if ingested from PatientContactAccessed events).
INSERT INTO audit_log (tenant_id, occurred_at, actor_subject, actor_role, patient_id, resource_type,
                       resource_id, action, outcome, correlation_id, source_service, source_message_id)
SELECT ('10000000-0000-4000-8000-' || lpad(t::text, 12, '0'))::uuid,
       now() - make_interval(days => k),
       ('30000000-0000-4000-8000-' || lpad(t::text, 8, '0') || '0002')::uuid,
       'receptionist',
       ('50000000-0000-4000-8000-' || lpad(t::text, 4, '0') || lpad(k::text, 8, '0'))::uuid,
       'patient_contact',
       ('50000000-0000-4000-8000-' || lpad(t::text, 4, '0') || lpad(k::text, 8, '0'))::uuid,
       CASE WHEN k % 4 = 0 THEN 'update' ELSE 'read' END,
       'success', gen_random_uuid(), 'user-management', gen_random_uuid()
FROM generate_series(1, 3) AS t
CROSS JOIN generate_series(1, 10) AS k;

-- -----------------------------------------------------------------------------
-- RF6 conflict example: a leave block created AFTER bookings for professional 1
-- on local day +5, 08:00–10:00. Booked appointments inside it stay booked and
-- are reported by GET /api/v1/schedule-conflicts.
-- -----------------------------------------------------------------------------
INSERT INTO calendar_blocks (tenant_id, professional_id, period, reason, note, created_by_subject)
SELECT t.id,
       ('42000000-0000-4000-8000-' || lpad(t.n::text, 8, '0') || '0001')::uuid,
       tstzrange(((now() AT TIME ZONE t.timezone)::date + 5 + TIME '08:00') AT TIME ZONE t.timezone,
                 ((now() AT TIME ZONE t.timezone)::date + 5 + TIME '10:00') AT TIME ZONE t.timezone, '[)'),
       'leave', 'Training session (conflict example)',
       ('30000000-0000-4000-8000-' || lpad(t.n::text, 8, '0') || '0001')::uuid
FROM (SELECT id, timezone, row_number() OVER (ORDER BY id) AS n FROM tenants) AS t;
