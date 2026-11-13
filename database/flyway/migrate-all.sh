#!/bin/bash
# =============================================================================
# MediCitas — one-shot migration runner (container: flyway, image flyway/flyway).
# Runs Flyway once per service database, as that database's *_owner role.
#
# Locations per database (merged and ordered by version):
#   /flyway/common                      shared kernel: app schema + reliability tables (V1_0, V1_1)
#   /flyway/services/<svc>/migrations   service schema (V2 ...)
#   /flyway/services/<svc>/seed         demo seed data (V900 ...), only when SEED_DEMO_DATA=true
#
# Placeholders: ${rolePrefix} (tm, um, sch, ...), ${schema} (service schema),
#               ${tenantScoped} (true for application-plane databases).
# Idempotent: applied versions are skipped; checksums are validated on every run.
# =============================================================================
set -euo pipefail

: "${POSTGRES_HOST:?}" "${POSTGRES_PORT:?}"
SEED_DEMO_DATA="${SEED_DEMO_DATA:-true}"

# db_name | prefix | schema | tenantScoped | service directory | owner password variable
SERVICES=(
  "medicitas_tenant|tm|tenancy|false|control-plane/tenant-management|TM_DB_OWNER_PASSWORD"
  "medicitas_onboarding|onb|onboarding|false|control-plane/onboarding-orchestrator|ONB_DB_OWNER_PASSWORD"
  "medicitas_user|um|identity|true|application-plane/user-management|UM_DB_OWNER_PASSWORD"
  "medicitas_user_orchestrator|umo|provisioning|true|application-plane/user-management-orchestrator|UMO_DB_OWNER_PASSWORD"
  "medicitas_catalog|cat|catalog|true|application-plane/catalog-service-management|CAT_DB_OWNER_PASSWORD"
  "medicitas_scheduler|sch|scheduling|true|application-plane/scheduler-management|SCH_DB_OWNER_PASSWORD"
  "medicitas_appointment_orchestrator|ao|booking|true|application-plane/appointment-orchestrator|AO_DB_OWNER_PASSWORD"
)

for entry in "${SERVICES[@]}"; do
  IFS='|' read -r db prefix schema tenant_scoped service_dir password_var <<< "$entry"
  password="${!password_var:?missing ${password_var}}"

  locations="filesystem:/flyway/common,filesystem:/flyway/services/${service_dir}/migrations"
  if [[ "$SEED_DEMO_DATA" == "true" && -d "/flyway/services/${service_dir}/seed" ]]; then
    locations="${locations},filesystem:/flyway/services/${service_dir}/seed"
  fi

  echo "[flyway] migrating ${db} (schema ${schema})"
  # Seeds use V900+. A schema migration added later (e.g. V3) must still apply on a volume that
  # already holds the seeds, hence outOfOrder=true; on a fresh volume the natural order is kept.
  # The password is passed through the environment, never on the command line.
  FLYWAY_PASSWORD="$password" flyway \
    -url="jdbc:postgresql://${POSTGRES_HOST}:${POSTGRES_PORT}/${db}" \
    -user="${prefix}_owner" \
    -schemas="${schema},app" \
    -locations="${locations}" \
    -placeholders.rolePrefix="${prefix}" \
    -placeholders.schema="${schema}" \
    -placeholders.tenantScoped="${tenant_scoped}" \
    -validateMigrationNaming=true \
    -connectRetries=20 \
    -cleanDisabled=true \
    -outOfOrder=true \
    migrate
done

echo "[flyway] all databases migrated"
