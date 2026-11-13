-- =============================================================================
-- appointment-orchestrator — actor role of the booking saga (Stage 4).
-- Commands re-sent or issued by the saga sweeper (compensations after a deadline)
-- must carry the same actor as the original request, because every participant
-- checks the actor-role allowlist of the message type (messaging-contracts §4).
-- =============================================================================

ALTER TABLE saga_instances ADD COLUMN actor_role text;
UPDATE saga_instances SET actor_role = 'receptionist' WHERE actor_role IS NULL;
ALTER TABLE saga_instances ALTER COLUMN actor_role SET NOT NULL;
ALTER TABLE saga_instances
    ADD CONSTRAINT saga_instances_actor_role CHECK (actor_role IN ('clinic_admin', 'receptionist'));

COMMENT ON COLUMN saga_instances.actor_role IS
    'MediCitas role of the user who requested the booking; copied into every command envelope of the saga.';
