-- =============================================================================
-- Demo seed (user-management): tenant replicas, clinic users and patients.
-- Identifier scheme (T = tenant number 1..3, N = sequence):
--   user id            20000000-0000-4000-8000-0000000T000N   (N: 1 admin, 2-3 reception, 11-13 professionals)
--   Keycloak subject   30000000-0000-4000-8000-0000000T000N   (must match the realm import, Stage 3)
--   patient id         50000000-0000-4000-8000-000T0000000N   (N: 1..120)
-- Runs as the owner role (BYPASSRLS), so no tenant context is needed.
-- =============================================================================

INSERT INTO tenants (id, slug, name, timezone, status, version) VALUES
    ('10000000-0000-4000-8000-000000000001', 'clinica-san-jose',      'Clínica San José',      'America/Costa_Rica', 'active', 1),
    ('10000000-0000-4000-8000-000000000002', 'centro-medico-heredia', 'Centro Médico Heredia', 'America/Costa_Rica', 'active', 1),
    ('10000000-0000-4000-8000-000000000003', 'clinica-del-istmo',     'Clínica del Istmo',     'America/Panama',     'active', 1);

INSERT INTO users (id, tenant_id, keycloak_subject, email, first_name, last_name, role, status, created_at)
SELECT ('20000000-0000-4000-8000-' || lpad(u.t::text, 8, '0') || lpad(u.n::text, 4, '0'))::uuid,
       ('10000000-0000-4000-8000-' || lpad(u.t::text, 12, '0'))::uuid,
       ('30000000-0000-4000-8000-' || lpad(u.t::text, 8, '0') || lpad(u.n::text, 4, '0'))::uuid,
       u.email, u.first_name, u.last_name, u.role, 'active',
       now() - interval '60 days'
FROM (VALUES
    (1,  1, 'clinic_admin',        'Ana',       'Mora',      'ana.mora@sanjose.medicitas.test'),
    (1,  2, 'receptionist',        'Carlos',    'Jiménez',   'carlos.jimenez@sanjose.medicitas.test'),
    (1,  3, 'receptionist',        'Laura',     'Vargas',    'laura.vargas@sanjose.medicitas.test'),
    (1, 11, 'health_professional', 'Andrés',    'Rojas',     'andres.rojas@sanjose.medicitas.test'),
    (1, 12, 'health_professional', 'Sofía',     'Castro',    'sofia.castro@sanjose.medicitas.test'),
    (1, 13, 'health_professional', 'Javier',    'Méndez',    'javier.mendez@sanjose.medicitas.test'),
    (2,  1, 'clinic_admin',        'Mariela',   'Quesada',   'mariela.quesada@heredia.medicitas.test'),
    (2,  2, 'receptionist',        'Diego',     'Araya',     'diego.araya@heredia.medicitas.test'),
    (2,  3, 'receptionist',        'Paola',     'Chaves',    'paola.chaves@heredia.medicitas.test'),
    (2, 11, 'health_professional', 'Gabriela',  'Herrera',   'gabriela.herrera@heredia.medicitas.test'),
    (2, 12, 'health_professional', 'Esteban',   'Ulate',     'esteban.ulate@heredia.medicitas.test'),
    (2, 13, 'health_professional', 'Natalia',   'Brenes',    'natalia.brenes@heredia.medicitas.test'),
    (3,  1, 'clinic_admin',        'Ricardo',   'Pinzón',    'ricardo.pinzon@istmo.medicitas.test'),
    (3,  2, 'receptionist',        'Yesenia',   'Batista',   'yesenia.batista@istmo.medicitas.test'),
    (3,  3, 'receptionist',        'Luis',      'Sánchez',   'luis.sanchez@istmo.medicitas.test'),
    (3, 11, 'health_professional', 'Omar',      'Delgado',   'omar.delgado@istmo.medicitas.test'),
    (3, 12, 'health_professional', 'Itzel',     'Camargo',   'itzel.camargo@istmo.medicitas.test'),
    (3, 13, 'health_professional', 'Rubén',     'Arosemena', 'ruben.arosemena@istmo.medicitas.test')
) AS u(t, n, role, first_name, last_name, email);

-- 120 synthetic patients per clinic, deterministic (names combined from fixed lists).
INSERT INTO patients (id, tenant_id, identification_type, identification_number, first_name, last_name,
                      birth_date, email, phone, address, status, created_by_subject, created_at)
SELECT ('50000000-0000-4000-8000-' || lpad(t.n::text, 4, '0') || lpad(p.n::text, 8, '0'))::uuid,
       ('10000000-0000-4000-8000-' || lpad(t.n::text, 12, '0'))::uuid,
       CASE WHEN p.n % 15 = 0 THEN 'passport' ELSE 'national_id' END,
       CASE WHEN p.n % 15 = 0
            THEN 'P' || lpad((t.n * 100000 + p.n * 37)::text, 8, '0')
            ELSE t.id_prefix || '-' || lpad((p.n * 7919 % 10000)::text, 4, '0') || '-' || lpad(p.n::text, 4, '0')
       END,
       fn.names[1 + (p.n * 7) % array_length(fn.names, 1)],
       ln.names[1 + (p.n * 13 + t.n) % array_length(ln.names, 1)],
       DATE '1945-01-01' + ((p.n * 211 + t.n * 97) % 27000),
       CASE WHEN p.n % 9 = 0 THEN NULL ELSE 'patient' || t.n || '.' || p.n || '@mail.example' END,
       t.phone_prefix || lpad(((p.n * 104729 + t.n) % 10000000)::text, 7, '0'),
       'Synthetic address ' || p.n || ', district ' || (1 + p.n % 12),
       CASE WHEN p.n = 120 THEN 'inactive' ELSE 'active' END,
       ('30000000-0000-4000-8000-' || lpad(t.n::text, 8, '0') || '0002')::uuid,
       now() - make_interval(days => 30 + p.n)
FROM (VALUES (1, '1', '+506 8'), (2, '4', '+506 7'), (3, '8', '+507 6')) AS t(n, id_prefix, phone_prefix)
CROSS JOIN generate_series(1, 120) AS p(n)
CROSS JOIN (SELECT ARRAY['María', 'José', 'Valeria', 'Daniel', 'Camila', 'Sebastián', 'Isabella', 'Mateo',
                         'Lucía', 'Gabriel', 'Fernanda', 'Alejandro', 'Mariana', 'Kevin', 'Daniela', 'Adrián',
                         'Andrea', 'Fabián', 'Natalia', 'Emilio'] AS names) AS fn
CROSS JOIN (SELECT ARRAY['Rodríguez', 'Vargas', 'Jiménez', 'Mora', 'Rojas', 'Alvarado', 'Solano', 'Campos',
                         'Chacón', 'Quirós', 'Salazar', 'Navarro', 'Cordero', 'Arias', 'Ramírez', 'Castillo',
                         'González', 'Herrera', 'Villalobos', 'Ureña'] AS names) AS ln;
