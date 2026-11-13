-- =============================================================================
-- Demo seed: three clinics.
-- Deterministic identifiers shared by every database and by the Keycloak realm:
--   tenant T            10000000-0000-4000-8000-00000000000T
--   onboarding saga T   60000000-0000-4000-8000-00000000000T
-- =============================================================================

INSERT INTO tenants (id, slug, name, timezone, status, onboarding_saga_id, version, activated_at)
VALUES
    ('10000000-0000-4000-8000-000000000001', 'clinica-san-jose',      'Clínica San José',      'America/Costa_Rica', 'active',
     '60000000-0000-4000-8000-000000000001', 1, now() - interval '120 days'),
    ('10000000-0000-4000-8000-000000000002', 'centro-medico-heredia', 'Centro Médico Heredia', 'America/Costa_Rica', 'active',
     '60000000-0000-4000-8000-000000000002', 1, now() - interval '90 days'),
    ('10000000-0000-4000-8000-000000000003', 'clinica-del-istmo',     'Clínica del Istmo',     'America/Panama',     'active',
     '60000000-0000-4000-8000-000000000003', 1, now() - interval '60 days');
