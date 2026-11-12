-- =============================================================================
-- RF7 scaling experiment (evidence only; everything is ROLLED BACK).
-- Adds ~8,000 extra active appointments for one professional (2.7 years ahead)
-- and shows that the RF7 plan still reads only the target day's rows.
-- Requires the superuser (to disable the booking triggers inside the transaction
-- so the synthetic load can be generated quickly; constraints stay active).
--   psql -U <superuser> -d medicitas_scheduler -f explain-rf7-volume.sql
-- =============================================================================
\set ON_ERROR_STOP on
\pset pager off
BEGIN;
ALTER TABLE scheduling.appointments DISABLE TRIGGER appointments_validate_insert;

INSERT INTO scheduling.appointments (id, tenant_id, patient_id, professional_id, service_id, slot, status, booked_by_subject)
SELECT gen_random_uuid(), '10000000-0000-4000-8000-000000000001', gen_random_uuid(),
       '42000000-0000-4000-8000-000000010001', '41000000-0000-4000-8000-000000010001',
       tstzrange(ts, ts + interval '30 minutes', '[)'), 'booked', gen_random_uuid()
FROM generate_series(30, 1030) AS d,
     generate_series(0, 7) AS k,
     LATERAL (SELECT ((current_date + d)::timestamp + time '08:00' + k * interval '30 minutes')
                     AT TIME ZONE 'America/Costa_Rica' AS ts) x;
ANALYZE scheduling.appointments;

SELECT count(*) AS active_appointments_of_professional
FROM scheduling.appointments
WHERE professional_id = '42000000-0000-4000-8000-000000010001' AND status IN ('held', 'booked');

SET LOCAL ROLE sch_receptionist;
SELECT set_config('app.tenant_id', '10000000-0000-4000-8000-000000000001', true) \gset
SELECT ((now() AT TIME ZONE 'America/Costa_Rica')::date
        + (8 - extract(isodow FROM (now() AT TIME ZONE 'America/Costa_Rica')::date))::int + 35) AS day \gset

EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT * FROM scheduling.compute_available_slots('42000000-0000-4000-8000-000000010001',
                                                 '41000000-0000-4000-8000-000000010001', DATE :'day');
-- Inline plan of the anti-join probe for that day (what the function executes):
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT count(*) FROM scheduling.appointments a
WHERE a.tenant_id = app.current_tenant_id()
  AND a.professional_id = '42000000-0000-4000-8000-000000010001'
  AND a.status IN ('held', 'booked')
  AND a.starts_at >= (SELECT DATE :'day'::timestamp AT TIME ZONE t.timezone FROM scheduling.tenants t WHERE t.id = app.current_tenant_id())
  AND a.starts_at <  (SELECT (DATE :'day' + 1)::timestamp AT TIME ZONE t.timezone FROM scheduling.tenants t WHERE t.id = app.current_tenant_id());
ROLLBACK;
