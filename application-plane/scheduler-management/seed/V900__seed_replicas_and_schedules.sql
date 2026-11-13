-- =============================================================================
-- Demo seed (scheduler): replicas identical to the catalog/tenant seeds, weekly
-- schedules (split shifts) and calendar blocks. In production these replicas are
-- filled by domain events; the seed writes them directly because seed data is
-- not announced through the outbox.
-- =============================================================================

INSERT INTO tenants (id, slug, name, timezone, status, version) VALUES
    ('10000000-0000-4000-8000-000000000001', 'clinica-san-jose',      'Clínica San José',      'America/Costa_Rica', 'active', 1),
    ('10000000-0000-4000-8000-000000000002', 'centro-medico-heredia', 'Centro Médico Heredia', 'America/Costa_Rica', 'active', 1),
    ('10000000-0000-4000-8000-000000000003', 'clinica-del-istmo',     'Clínica del Istmo',     'America/Panama',     'active', 1);

INSERT INTO catalog_services (id, tenant_id, specialty_id, name, duration_minutes, status, version)
SELECT ('41000000-0000-4000-8000-' || lpad(t::text, 8, '0') || lpad(s.n::text, 4, '0'))::uuid,
       ('10000000-0000-4000-8000-' || lpad(t::text, 12, '0'))::uuid,
       ('40000000-0000-4000-8000-' || lpad(t::text, 8, '0') || lpad(s.specialty::text, 4, '0'))::uuid,
       s.name, s.duration, 'active', 1
FROM generate_series(1, 3) AS t
CROSS JOIN (VALUES
    (1, 1, 'General consultation',         30),
    (2, 1, 'Follow-up visit',              15),
    (3, 2, 'Pediatric consultation',       30),
    (4, 2, 'Well-child check-up',          45),
    (5, 3, 'Dermatology assessment',       45),
    (6, 3, 'Minor dermatologic procedure', 60)
) AS s(n, specialty, name, duration);

-- The AFTER INSERT trigger creates one professional_agendas anchor per professional.
INSERT INTO catalog_professionals (id, tenant_id, user_id, keycloak_subject, display_name, specialty_id,
                                   status, version, services_version)
SELECT ('42000000-0000-4000-8000-' || lpad(p.t::text, 8, '0') || lpad(p.n::text, 4, '0'))::uuid,
       ('10000000-0000-4000-8000-' || lpad(p.t::text, 12, '0'))::uuid,
       ('20000000-0000-4000-8000-' || lpad(p.t::text, 8, '0') || lpad((p.n + 10)::text, 4, '0'))::uuid,
       ('30000000-0000-4000-8000-' || lpad(p.t::text, 8, '0') || lpad((p.n + 10)::text, 4, '0'))::uuid,
       p.display_name,
       ('40000000-0000-4000-8000-' || lpad(p.t::text, 8, '0') || lpad(p.n::text, 4, '0'))::uuid,
       'active', 1, 1
FROM (VALUES
    (1, 1, 'Dr. Andrés Rojas'),      (1, 2, 'Dra. Sofía Castro'),  (1, 3, 'Dr. Javier Méndez'),
    (2, 1, 'Dra. Gabriela Herrera'), (2, 2, 'Dr. Esteban Ulate'),  (2, 3, 'Dra. Natalia Brenes'),
    (3, 1, 'Dr. Omar Delgado'),      (3, 2, 'Dra. Itzel Camargo'), (3, 3, 'Dr. Rubén Arosemena')
) AS p(t, n, display_name);

INSERT INTO catalog_professional_services (tenant_id, professional_id, service_id)
SELECT ('10000000-0000-4000-8000-' || lpad(t::text, 12, '0'))::uuid,
       ('42000000-0000-4000-8000-' || lpad(t::text, 8, '0') || lpad(p::text, 4, '0'))::uuid,
       ('41000000-0000-4000-8000-' || lpad(t::text, 8, '0') || lpad((2 * p - k)::text, 4, '0'))::uuid
FROM generate_series(1, 3) AS t
CROSS JOIN generate_series(1, 3) AS p
CROSS JOIN (VALUES (0), (1)) AS x(k);

-- Weekly schedules (RF5), same pattern in every clinic:
--   professional 1 (general medicine): Mon–Fri 08:00–12:00 and 13:00–17:00 (split shift)
--   professional 2 (pediatrics):       Mon/Wed/Fri 07:00–13:00; Tue/Thu 14:00–19:00
--   professional 3 (dermatology):      Tue–Fri 09:00–12:30 and 14:00–18:00; Sat 08:00–12:00
INSERT INTO weekly_schedule_blocks (tenant_id, professional_id, day_of_week, start_time, end_time)
SELECT ('10000000-0000-4000-8000-' || lpad(t::text, 12, '0'))::uuid,
       ('42000000-0000-4000-8000-' || lpad(t::text, 8, '0') || lpad(b.p::text, 4, '0'))::uuid,
       b.dow, b.start_time, b.end_time
FROM generate_series(1, 3) AS t
CROSS JOIN (
    SELECT 1 AS p, dow, s.start_time, s.end_time
    FROM generate_series(1, 5) AS dow
    CROSS JOIN (VALUES (TIME '08:00', TIME '12:00'), (TIME '13:00', TIME '17:00')) AS s(start_time, end_time)
    UNION ALL
    SELECT 2, dow, TIME '07:00', TIME '13:00' FROM unnest(ARRAY[1, 3, 5]) AS dow
    UNION ALL
    SELECT 2, dow, TIME '14:00', TIME '19:00' FROM unnest(ARRAY[2, 4]) AS dow
    UNION ALL
    SELECT 3, dow, s.start_time, s.end_time
    FROM generate_series(2, 5) AS dow
    CROSS JOIN (VALUES (TIME '09:00', TIME '12:30'), (TIME '14:00', TIME '18:00')) AS s(start_time, end_time)
    UNION ALL
    SELECT 3, 6, TIME '08:00', TIME '12:00'
) AS b;

-- Calendar blocks (RF6) created BEFORE the appointment seed, so seeded appointments respect them:
--   professional 3: vacation from local day +10 to +13 (whole days)
--   professional 1: medical leave on local day -20, 08:00–12:00
INSERT INTO calendar_blocks (tenant_id, professional_id, period, reason, note, created_by_subject, created_at)
SELECT t.id,
       ('42000000-0000-4000-8000-' || lpad(t.n::text, 8, '0') || '0003')::uuid,
       tstzrange(((now() AT TIME ZONE t.timezone)::date + 10)::timestamp AT TIME ZONE t.timezone,
                 ((now() AT TIME ZONE t.timezone)::date + 14)::timestamp AT TIME ZONE t.timezone, '[)'),
       'vacation', 'Annual vacation',
       ('30000000-0000-4000-8000-' || lpad(t.n::text, 8, '0') || '0001')::uuid,
       now() - interval '30 days'
FROM (SELECT id, timezone, row_number() OVER (ORDER BY id) AS n FROM tenants) AS t
UNION ALL
SELECT t.id,
       ('42000000-0000-4000-8000-' || lpad(t.n::text, 8, '0') || '0001')::uuid,
       tstzrange(((now() AT TIME ZONE t.timezone)::date - 20 + TIME '08:00') AT TIME ZONE t.timezone,
                 ((now() AT TIME ZONE t.timezone)::date - 20 + TIME '12:00') AT TIME ZONE t.timezone, '[)'),
       'leave', 'Medical leave (morning)',
       ('30000000-0000-4000-8000-' || lpad(t.n::text, 8, '0') || '0001')::uuid,
       now() - interval '40 days'
FROM (SELECT id, timezone, row_number() OVER (ORDER BY id) AS n FROM tenants) AS t;
