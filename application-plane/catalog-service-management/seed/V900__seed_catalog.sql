-- =============================================================================
-- Demo seed (catalog): per clinic 3 specialties, 6 services, 3 professionals.
-- Identifier scheme (T = tenant 1..3, N = sequence):
--   specialty     40000000-0000-4000-8000-0000000T000N
--   service       41000000-0000-4000-8000-0000000T000N
--   professional  42000000-0000-4000-8000-0000000T000N  (user N+10, subject 30000000-…-0000000T00(N+10))
-- The scheduler seed replicates exactly these rows (event-carried state).
-- =============================================================================

INSERT INTO tenants (id, slug, name, timezone, status, version) VALUES
    ('10000000-0000-4000-8000-000000000001', 'clinica-san-jose',      'Clínica San José',      'America/Costa_Rica', 'active', 1),
    ('10000000-0000-4000-8000-000000000002', 'centro-medico-heredia', 'Centro Médico Heredia', 'America/Costa_Rica', 'active', 1),
    ('10000000-0000-4000-8000-000000000003', 'clinica-del-istmo',     'Clínica del Istmo',     'America/Panama',     'active', 1);

INSERT INTO specialties (id, tenant_id, name)
SELECT ('40000000-0000-4000-8000-' || lpad(t::text, 8, '0') || lpad(s.n::text, 4, '0'))::uuid,
       ('10000000-0000-4000-8000-' || lpad(t::text, 12, '0'))::uuid,
       s.name
FROM generate_series(1, 3) AS t
CROSS JOIN (VALUES (1, 'General Medicine'), (2, 'Pediatrics'), (3, 'Dermatology')) AS s(n, name);

INSERT INTO services (id, tenant_id, specialty_id, name, duration_minutes)
SELECT ('41000000-0000-4000-8000-' || lpad(t::text, 8, '0') || lpad(s.n::text, 4, '0'))::uuid,
       ('10000000-0000-4000-8000-' || lpad(t::text, 12, '0'))::uuid,
       ('40000000-0000-4000-8000-' || lpad(t::text, 8, '0') || lpad(s.specialty::text, 4, '0'))::uuid,
       s.name, s.duration
FROM generate_series(1, 3) AS t
CROSS JOIN (VALUES
    (1, 1, 'General consultation',         30),
    (2, 1, 'Follow-up visit',              15),
    (3, 2, 'Pediatric consultation',       30),
    (4, 2, 'Well-child check-up',          45),
    (5, 3, 'Dermatology assessment',       45),
    (6, 3, 'Minor dermatologic procedure', 60)
) AS s(n, specialty, name, duration);

INSERT INTO professionals (id, tenant_id, user_id, keycloak_subject, specialty_id, display_name, license_number)
SELECT ('42000000-0000-4000-8000-' || lpad(p.t::text, 8, '0') || lpad(p.n::text, 4, '0'))::uuid,
       ('10000000-0000-4000-8000-' || lpad(p.t::text, 12, '0'))::uuid,
       ('20000000-0000-4000-8000-' || lpad(p.t::text, 8, '0') || lpad((p.n + 10)::text, 4, '0'))::uuid,
       ('30000000-0000-4000-8000-' || lpad(p.t::text, 8, '0') || lpad((p.n + 10)::text, 4, '0'))::uuid,
       ('40000000-0000-4000-8000-' || lpad(p.t::text, 8, '0') || lpad(p.n::text, 4, '0'))::uuid,
       p.display_name,
       'LIC-' || p.t || '-' || (1000 + p.n)
FROM (VALUES
    (1, 1, 'Dr. Andrés Rojas'),     (1, 2, 'Dra. Sofía Castro'),    (1, 3, 'Dr. Javier Méndez'),
    (2, 1, 'Dra. Gabriela Herrera'), (2, 2, 'Dr. Esteban Ulate'),   (2, 3, 'Dra. Natalia Brenes'),
    (3, 1, 'Dr. Omar Delgado'),     (3, 2, 'Dra. Itzel Camargo'),   (3, 3, 'Dr. Rubén Arosemena')
) AS p(t, n, display_name);

-- Professional N (specialty N) performs services 2N-1 and 2N (same specialty).
INSERT INTO professional_services (tenant_id, professional_id, service_id)
SELECT ('10000000-0000-4000-8000-' || lpad(t::text, 12, '0'))::uuid,
       ('42000000-0000-4000-8000-' || lpad(t::text, 8, '0') || lpad(p::text, 4, '0'))::uuid,
       ('41000000-0000-4000-8000-' || lpad(t::text, 8, '0') || lpad((2 * p - k)::text, 4, '0'))::uuid
FROM generate_series(1, 3) AS t
CROSS JOIN generate_series(1, 3) AS p
CROSS JOIN (VALUES (0), (1)) AS x(k);
