-- =============================================================================
-- onboarding-orchestrator — explicit compensation steps.
-- The Keycloak group and first admin user created by an onboarding saga are
-- deleted by dedicated, idempotent saga steps when the saga compensates.
-- =============================================================================

ALTER TABLE saga_steps DROP CONSTRAINT saga_steps_name;
ALTER TABLE saga_steps ADD CONSTRAINT saga_steps_name CHECK (step_name IN (
    'create_tenant', 'keycloak_group', 'keycloak_admin_user', 'activate_tenant', 'mark_tenant_failed',
    'delete_keycloak_user', 'delete_keycloak_group'));
