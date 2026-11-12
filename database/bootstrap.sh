#!/bin/sh
# =============================================================================
# MediCitas — one-shot database bootstrap (container: db-bootstrap, image postgres:18).
# Creates cluster roles and service databases idempotently, then exits 0.
# Secrets come from environment variables and are passed to psql as variables;
# they are never echoed (no -a/-e flags, ECHO off).
# =============================================================================
set -eu

: "${POSTGRES_HOST:?}" "${POSTGRES_PORT:?}" "${POSTGRES_USER:?}" "${POSTGRES_PASSWORD:?}"
: "${TM_DB_OWNER_PASSWORD:?}" "${TM_DB_APP_PASSWORD:?}"
: "${ONB_DB_OWNER_PASSWORD:?}" "${ONB_DB_APP_PASSWORD:?}"
: "${UM_DB_OWNER_PASSWORD:?}" "${UM_DB_APP_PASSWORD:?}"
: "${UMO_DB_OWNER_PASSWORD:?}" "${UMO_DB_APP_PASSWORD:?}"
: "${CAT_DB_OWNER_PASSWORD:?}" "${CAT_DB_APP_PASSWORD:?}"
: "${SCH_DB_OWNER_PASSWORD:?}" "${SCH_DB_APP_PASSWORD:?}"
: "${AO_DB_OWNER_PASSWORD:?}" "${AO_DB_APP_PASSWORD:?}"
: "${DB_EVIDENCE_PASSWORD:?}"

export PGPASSWORD="$POSTGRES_PASSWORD"
# Idempotent re-runs emit "already exists" notices; only warnings and errors are relevant.
export PGOPTIONS="-c client_min_messages=warning"
PSQL="psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -d postgres"

echo "[db-bootstrap] creating roles"
$PSQL \
  -v tm_owner_pw="$TM_DB_OWNER_PASSWORD"   -v tm_app_pw="$TM_DB_APP_PASSWORD" \
  -v onb_owner_pw="$ONB_DB_OWNER_PASSWORD" -v onb_app_pw="$ONB_DB_APP_PASSWORD" \
  -v um_owner_pw="$UM_DB_OWNER_PASSWORD"   -v um_app_pw="$UM_DB_APP_PASSWORD" \
  -v umo_owner_pw="$UMO_DB_OWNER_PASSWORD" -v umo_app_pw="$UMO_DB_APP_PASSWORD" \
  -v cat_owner_pw="$CAT_DB_OWNER_PASSWORD" -v cat_app_pw="$CAT_DB_APP_PASSWORD" \
  -v sch_owner_pw="$SCH_DB_OWNER_PASSWORD" -v sch_app_pw="$SCH_DB_APP_PASSWORD" \
  -v ao_owner_pw="$AO_DB_OWNER_PASSWORD"   -v ao_app_pw="$AO_DB_APP_PASSWORD" \
  -v evidence_pw="$DB_EVIDENCE_PASSWORD" \
  -f /bootstrap/roles/roles.sql > /dev/null

echo "[db-bootstrap] creating databases"
$PSQL -f /bootstrap/migrations/databases.sql > /dev/null

echo "[db-bootstrap] done"
