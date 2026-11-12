-- =============================================================================
-- EXPLAIN (ANALYZE, BUFFERS) evidence for the main scheduler queries, on the
-- production path: runtime login sch_app, actor role via SET LOCAL ROLE, tenant
-- context via set_config (discriminator + RLS, mode C of ADR-0004).
--   psql -h postgres -U sch_app -d medicitas_scheduler -f explain-main-queries.sql
-- Parameters: clinic 1, professional 1 (general medicine), service 1 (30 min),
-- next Monday in the clinic timezone.
-- =============================================================================
\set ON_ERROR_STOP on
\pset pager off

\set tenant '10000000-0000-4000-8000-000000000001'
\set professional '42000000-0000-4000-8000-000000010001'
\set service '41000000-0000-4000-8000-000000010001'
\set patient '50000000-0000-4000-8000-000100000010'

SELECT ((now() AT TIME ZONE 'America/Costa_Rica')::date
        + (8 - extract(isodow FROM (now() AT TIME ZONE 'America/Costa_Rica')::date))::int) AS day \gset

\echo '=== Table sizes (tenant 1 context) ==='
BEGIN;
SET LOCAL ROLE sch_receptionist;
SELECT set_config('app.tenant_id', :'tenant', true) \gset
SELECT 'appointments' AS table_name, count(*) FROM appointments
UNION ALL SELECT 'calendar_blocks', count(*) FROM calendar_blocks
UNION ALL SELECT 'weekly_schedule_blocks', count(*) FROM weekly_schedule_blocks;
ROLLBACK;

\echo '=== RF7: availability (body of compute_available_slots inlined so the plan is visible) ==='
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE sch_receptionist;
SELECT set_config('app.tenant_id', :'tenant', true) \gset
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
WITH ctx AS (
    SELECT t.timezone AS tz, s.duration_minutes AS duration, st.slot_step_minutes AS step
    FROM tenants t
    JOIN catalog_services s ON s.tenant_id = t.id AND s.id = :'service' AND s.status = 'active'
    JOIN catalog_professionals p ON p.tenant_id = t.id AND p.id = :'professional' AND p.status = 'active'
    JOIN catalog_professional_services ps ON ps.tenant_id = t.id AND ps.professional_id = p.id AND ps.service_id = s.id
    CROSS JOIN scheduling_settings st
    WHERE t.id = app.current_tenant_id()
),
working_blocks AS (
    SELECT (DATE :'day' + b.start_time) AT TIME ZONE ctx.tz AS block_start,
           (DATE :'day' + b.end_time) AT TIME ZONE ctx.tz AS block_end, ctx.duration, ctx.step
    FROM weekly_schedule_blocks b CROSS JOIN ctx
    WHERE b.tenant_id = app.current_tenant_id() AND b.professional_id = :'professional'
      AND b.day_of_week = extract(isodow FROM DATE :'day')
),
candidates AS (
    SELECT g AS start_at, g + make_interval(mins => wb.duration) AS end_at
    FROM working_blocks wb
    CROSS JOIN LATERAL generate_series(wb.block_start, wb.block_end - make_interval(mins => wb.duration),
                                       make_interval(mins => wb.step)) AS g
)
SELECT c.start_at, c.end_at FROM candidates c
WHERE NOT EXISTS (SELECT 1 FROM appointments a
                  WHERE a.tenant_id = app.current_tenant_id() AND a.professional_id = :'professional'
                    AND a.status IN ('held', 'booked')
                    AND a.starts_at >= (SELECT DATE :'day'::timestamp AT TIME ZONE t.timezone FROM tenants t WHERE t.id = app.current_tenant_id())
                    AND a.starts_at <  (SELECT (DATE :'day' + 1)::timestamp AT TIME ZONE t.timezone FROM tenants t WHERE t.id = app.current_tenant_id())
                    AND a.starts_at < c.end_at AND a.ends_at > c.start_at)
  AND NOT EXISTS (SELECT 1 FROM calendar_blocks cb
                  WHERE cb.tenant_id = app.current_tenant_id() AND cb.professional_id = :'professional'
                    AND cb.status = 'active' AND cb.period && tstzrange(c.start_at, c.end_at, '[)'))
ORDER BY c.start_at;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT * FROM availability_versions
WHERE tenant_id = app.current_tenant_id() AND professional_id = :'professional' AND local_date = DATE :'day';
ROLLBACK;

\echo '=== RF16: patient history ==='
BEGIN;
SET LOCAL ROLE sch_receptionist;
SELECT set_config('app.tenant_id', :'tenant', true) \gset
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT id, professional_id, service_id, slot, status FROM appointments
WHERE tenant_id = app.current_tenant_id() AND patient_id = :'patient'
ORDER BY starts_at DESC LIMIT 20;
ROLLBACK;

\echo '=== RF20: clinic-wide day agenda ==='
BEGIN;
SET LOCAL ROLE sch_receptionist;
SELECT set_config('app.tenant_id', :'tenant', true) \gset
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT a.id, a.slot, a.status, a.patient_id, a.professional_id, p.display_name, s.name
FROM appointments a
JOIN catalog_professionals p ON p.tenant_id = a.tenant_id AND p.id = a.professional_id
JOIN catalog_services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id
WHERE a.tenant_id = app.current_tenant_id()
  AND a.starts_at >= (DATE :'day')::timestamp AT TIME ZONE 'America/Costa_Rica'
  AND a.starts_at <  (DATE :'day' + 1)::timestamp AT TIME ZONE 'America/Costa_Rica'
  AND a.status NOT IN ('held', 'released')
ORDER BY a.starts_at, p.display_name;
ROLLBACK;

\echo '=== RF21: counts by status over 30 days ==='
BEGIN;
SET LOCAL ROLE sch_receptionist;
SELECT set_config('app.tenant_id', :'tenant', true) \gset
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT status, count(*) FROM appointments
WHERE tenant_id = app.current_tenant_id()
  AND starts_at >= (DATE :'day' - 30)::timestamp AT TIME ZONE 'America/Costa_Rica'
  AND starts_at <  (DATE :'day')::timestamp AT TIME ZONE 'America/Costa_Rica'
  AND status NOT IN ('held', 'released')
GROUP BY status;
ROLLBACK;

\echo '=== RF19: audit log by patient, newest first ==='
BEGIN;
SET LOCAL ROLE sch_clinic_admin;
SELECT set_config('app.tenant_id', :'tenant', true) \gset
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT id, occurred_at, actor_subject, action, resource_type FROM audit_log
WHERE tenant_id = app.current_tenant_id() AND patient_id = :'patient'
ORDER BY occurred_at DESC LIMIT 50;
ROLLBACK;
