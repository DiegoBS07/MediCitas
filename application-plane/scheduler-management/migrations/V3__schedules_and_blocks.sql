-- =============================================================================
-- scheduler-management — weekly schedules (RF5), calendar blocks (RF6),
-- availability versions (ADR-0008).
-- =============================================================================

CREATE TABLE weekly_schedule_blocks (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid        NOT NULL,
    professional_id  uuid        NOT NULL,
    day_of_week      smallint    NOT NULL,
    start_time       time        NOT NULL,
    end_time         time        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT weekly_schedule_blocks_agenda_fk FOREIGN KEY (tenant_id, professional_id)
        REFERENCES professional_agendas (tenant_id, professional_id),
    CONSTRAINT weekly_schedule_blocks_day CHECK (day_of_week BETWEEN 1 AND 7),
    CONSTRAINT weekly_schedule_blocks_order CHECK (start_time < end_time OR end_time = TIME '24:00'),
    CONSTRAINT weekly_schedule_blocks_grid CHECK (
        extract(second FROM start_time) = 0 AND extract(second FROM end_time) = 0
        AND extract(minute FROM start_time)::int % 5 = 0 AND extract(minute FROM end_time)::int % 5 = 0),
    -- Two blocks of the same professional and weekday never overlap (SCHEDULE_OVERLAP).
    CONSTRAINT weekly_schedule_blocks_no_overlap EXCLUDE USING gist (
        tenant_id WITH =,
        professional_id WITH =,
        day_of_week WITH =,
        tsrange(DATE '2000-01-03' + start_time, DATE '2000-01-03' + end_time, '[)') WITH &&)
);
COMMENT ON TABLE weekly_schedule_blocks IS
    'Weekly working hours (RF5): several blocks per day allowed (split shifts). Times are local to the tenant timezone. A schedule is replaced as a whole set.';
COMMENT ON COLUMN weekly_schedule_blocks.day_of_week IS 'ISO weekday: 1 = Monday … 7 = Sunday.';
COMMENT ON COLUMN weekly_schedule_blocks.start_time IS 'Local start time (inclusive).';
COMMENT ON COLUMN weekly_schedule_blocks.end_time IS 'Local end time (exclusive); 24:00 allowed.';

CREATE TABLE calendar_blocks (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid        NOT NULL,
    professional_id      uuid        NOT NULL,
    period               tstzrange   NOT NULL,
    reason               text        NOT NULL,
    note                 text,
    status               text        NOT NULL DEFAULT 'active',
    created_by_subject   uuid        NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    removed_by_subject   uuid,
    removed_at           timestamptz,
    CONSTRAINT calendar_blocks_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT calendar_blocks_agenda_fk FOREIGN KEY (tenant_id, professional_id)
        REFERENCES professional_agendas (tenant_id, professional_id),
    CONSTRAINT calendar_blocks_period_bounded CHECK (
        NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period)
        AND lower_inc(period) AND NOT upper_inc(period)),
    CONSTRAINT calendar_blocks_period_max_span CHECK (upper(period) - lower(period) <= interval '90 days'),
    CONSTRAINT calendar_blocks_reason CHECK (reason IN ('vacation', 'leave', 'other')),
    CONSTRAINT calendar_blocks_note_length CHECK (note IS NULL OR char_length(note) <= 200),
    CONSTRAINT calendar_blocks_status CHECK (status IN ('active', 'removed')),
    CONSTRAINT calendar_blocks_removed_consistency CHECK (
        (status = 'removed') = (removed_at IS NOT NULL AND removed_by_subject IS NOT NULL))
);
COMMENT ON TABLE calendar_blocks IS
    'Agenda blocks for vacations or leave (RF6). They remove availability going forward but never cancel booked appointments (listed as conflicts).';
COMMENT ON COLUMN calendar_blocks.period IS 'Blocked interval [start, end) in absolute time.';
COMMENT ON COLUMN calendar_blocks.status IS 'active, or removed (logical removal restores availability).';

CREATE INDEX calendar_blocks_active_period_idx ON calendar_blocks USING gist (tenant_id, professional_id, period)
    WHERE status = 'active';
COMMENT ON INDEX calendar_blocks_active_period_idx IS 'RF7/I3: active blocks overlapping a day or a slot for one professional.';

-- -----------------------------------------------------------------------------
-- Availability versions (cache keys, ADR-0008)
-- -----------------------------------------------------------------------------
CREATE TABLE availability_versions (
    tenant_id        uuid        NOT NULL,
    professional_id  uuid        NOT NULL,
    local_date       date        NOT NULL,
    version          bigint      NOT NULL DEFAULT 1,
    updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT availability_versions_pk PRIMARY KEY (tenant_id, professional_id, local_date),
    CONSTRAINT availability_versions_agenda_fk FOREIGN KEY (tenant_id, professional_id)
        REFERENCES professional_agendas (tenant_id, professional_id),
    CONSTRAINT availability_versions_positive CHECK (version >= 1)
);
COMMENT ON TABLE availability_versions IS
    'Monotonic version per (professional, local date), bumped in the same transaction as any change affecting availability. Absent row = version 0. Part of the Redis key (I8).';

-- Bumps the versions of the given local dates in a deterministic order (lock ordering, ADR-0007).
CREATE OR REPLACE FUNCTION bump_availability_versions(p_tenant_id uuid, p_professional_id uuid, p_dates date[])
RETURNS TABLE (local_date date, version bigint)
LANGUAGE sql AS $$
    INSERT INTO ${schema}.availability_versions AS av (tenant_id, professional_id, local_date, version)
    SELECT p_tenant_id, p_professional_id, d.local_date, 1
    FROM (SELECT DISTINCT unnest(p_dates) AS local_date) d
    ORDER BY d.local_date
    ON CONFLICT ON CONSTRAINT availability_versions_pk
        DO UPDATE SET version = av.version + 1, updated_at = clock_timestamp()
    RETURNING av.local_date, av.version;
$$;
COMMENT ON FUNCTION bump_availability_versions(uuid, uuid, date[]) IS
    'Increments availability versions of the given local dates (sorted, to keep a global lock order).';

-- Local dates (tenant timezone) touched by an absolute interval.
CREATE OR REPLACE FUNCTION local_dates_spanned(p_period tstzrange, p_timezone text)
RETURNS date[]
LANGUAGE sql STABLE AS $$
    SELECT array_agg(g::date ORDER BY g)
    FROM generate_series(
        (lower(p_period) AT TIME ZONE p_timezone)::date,
        ((upper(p_period) - interval '1 microsecond') AT TIME ZONE p_timezone)::date,
        interval '1 day') AS g;
$$;
COMMENT ON FUNCTION local_dates_spanned(tstzrange, text) IS 'Local dates covered by [lower, upper) in the given IANA timezone.';
