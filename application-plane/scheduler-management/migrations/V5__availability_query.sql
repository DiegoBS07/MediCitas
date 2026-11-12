-- =============================================================================
-- scheduler-management — RF7 availability computation (the most frequent query).
-- Kept in the database so that the service, the cache (ADR-0008), the seeds and
-- the EXPLAIN evidence all use exactly the same definition.
--
-- Returns every free slot of the local date (past slots included: the service
-- filters startAt > now() AFTER the cache, so cached entries do not age).
-- Both strategies are applied: explicit tenant predicate (discriminator) and RLS.
-- Call it inside a REPEATABLE READ READ ONLY transaction together with the
-- version lookup (ADR-0007/0008).
-- =============================================================================

CREATE OR REPLACE FUNCTION compute_available_slots(
    p_professional_id uuid,
    p_service_id      uuid,
    p_local_date      date
)
RETURNS TABLE (start_at timestamptz, end_at timestamptz)
LANGUAGE sql STABLE AS $$
    WITH ctx AS (
        SELECT t.timezone           AS tz,
               s.duration_minutes   AS duration,
               st.slot_step_minutes AS step
        FROM ${schema}.tenants t
        JOIN ${schema}.catalog_services s
          ON s.tenant_id = t.id AND s.id = p_service_id AND s.status = 'active'
        JOIN ${schema}.catalog_professionals p
          ON p.tenant_id = t.id AND p.id = p_professional_id AND p.status = 'active'
        JOIN ${schema}.catalog_professional_services ps
          ON ps.tenant_id = t.id AND ps.professional_id = p.id AND ps.service_id = s.id
        CROSS JOIN ${schema}.scheduling_settings st
        WHERE t.id = app.current_tenant_id()
    ),
    working_blocks AS (
        SELECT (p_local_date + b.start_time) AT TIME ZONE ctx.tz AS block_start,
               (p_local_date + b.end_time)   AT TIME ZONE ctx.tz AS block_end,
               ctx.duration, ctx.step
        FROM ${schema}.weekly_schedule_blocks b
        CROSS JOIN ctx
        WHERE b.tenant_id = app.current_tenant_id()
          AND b.professional_id = p_professional_id
          AND b.day_of_week = extract(isodow FROM p_local_date)
    ),
    candidates AS (
        SELECT g AS start_at, g + make_interval(mins => wb.duration) AS end_at
        FROM working_blocks wb
        CROSS JOIN LATERAL generate_series(
            wb.block_start,
            wb.block_end - make_interval(mins => wb.duration),
            make_interval(mins => wb.step)) AS g
    )
    SELECT c.start_at, c.end_at
    FROM candidates c
    -- Overlap written with timestamptz comparisons (leakproof) instead of slot && range, so it can be an
    -- index condition on appointments_active_professional_start_idx even under RLS. Appointments never
    -- cross the local midnight (they live inside one weekly block), so only rows starting on the same
    -- local day can overlap; the day bounds are scalar sub-queries (InitPlans) usable as index bounds.
    WHERE NOT EXISTS (
            SELECT 1 FROM ${schema}.appointments a
            WHERE a.tenant_id = app.current_tenant_id()
              AND a.professional_id = p_professional_id
              AND a.status IN ('held', 'booked')
              AND a.starts_at >= (SELECT p_local_date::timestamp AT TIME ZONE t.timezone
                                  FROM ${schema}.tenants t WHERE t.id = app.current_tenant_id())
              AND a.starts_at <  (SELECT (p_local_date + 1)::timestamp AT TIME ZONE t.timezone
                                  FROM ${schema}.tenants t WHERE t.id = app.current_tenant_id())
              AND a.starts_at < c.end_at
              AND a.ends_at > c.start_at)
      AND NOT EXISTS (
            SELECT 1 FROM ${schema}.calendar_blocks cb
            WHERE cb.tenant_id = app.current_tenant_id()
              AND cb.professional_id = p_professional_id
              AND cb.status = 'active'
              AND cb.period && tstzrange(c.start_at, c.end_at, '[)'))
    ORDER BY c.start_at;
$$;

COMMENT ON FUNCTION compute_available_slots(uuid, uuid, date) IS
    'RF7: free slots of a professional for a service on a local date = weekly blocks of that weekday, cut on the grid by the service duration, minus active appointments (held/booked) and active calendar blocks. Empty when the professional/service is inactive or not associated.';
