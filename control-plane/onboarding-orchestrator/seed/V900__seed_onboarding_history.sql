-- =============================================================================
-- Demo seed: completed onboarding sagas of the three seeded clinics, so that the
-- control-plane history is consistent with tenant-management.
-- =============================================================================

INSERT INTO saga_instances (id, tenant_id, status, request, result, actor_subject, correlation_id,
                            deadline_at, completed_at)
SELECT ('60000000-0000-4000-8000-' || lpad(t.n::text, 12, '0'))::uuid,
       ('10000000-0000-4000-8000-' || lpad(t.n::text, 12, '0'))::uuid,
       'completed',
       jsonb_build_object('name', t.name, 'slug', t.slug, 'timezone', t.timezone,
                          'firstAdmin', jsonb_build_object('email', t.admin_email)),
       jsonb_build_object('tenantId', '10000000-0000-4000-8000-' || lpad(t.n::text, 12, '0'), 'status', 'active'),
       '30000000-0000-4000-8000-000000000000',
       gen_random_uuid(),
       now() - t.age + interval '2 minutes',
       now() - t.age
FROM (VALUES
    (1, 'Clínica San José',      'clinica-san-jose',      'America/Costa_Rica', 'ana.mora@sanjose.medicitas.test',         interval '120 days'),
    (2, 'Centro Médico Heredia', 'centro-medico-heredia', 'America/Costa_Rica', 'mariela.quesada@heredia.medicitas.test',  interval '90 days'),
    (3, 'Clínica del Istmo',     'clinica-del-istmo',     'America/Panama',     'ricardo.pinzon@istmo.medicitas.test',     interval '60 days')
) AS t(n, name, slug, timezone, admin_email, age);

INSERT INTO saga_steps (saga_id, step_name, status, attempts, last_attempt_at)
SELECT s.id, step.name, 'succeeded', 1, s.completed_at
FROM saga_instances s
CROSS JOIN (VALUES ('create_tenant'), ('keycloak_group'), ('keycloak_admin_user'), ('activate_tenant')) AS step(name);
