#!/bin/sh
# =============================================================================
# Generates the Markdown data dictionary from the live catalog (COMMENT ON ...),
# so the dictionary can never drift from the migrations.
#
#   docker compose run --rm --no-deps --entrypoint sh db-bootstrap \
#     /bootstrap/tools/generate-data-dictionary.sh > docs/data/data-dictionary.md
# =============================================================================
set -eu
export PGPASSWORD="$POSTGRES_PASSWORD"

echo "# MediCitas — Data Dictionary"
echo
echo "> Generated from the PostgreSQL catalog by \`database/tools/generate-data-dictionary.sh\`."
echo "> Do not edit by hand: descriptions come from \`COMMENT ON\` statements in the migrations."
echo "> Reliability tables (\`outbox_messages\`, \`inbox_messages\`, \`idempotency_records\`) are identical in every database and are documented once, under tenant-management."

for entry in \
  "medicitas_tenant|tenancy|tenant-management" \
  "medicitas_onboarding|onboarding|onboarding-orchestrator" \
  "medicitas_user|identity|user-management" \
  "medicitas_user_orchestrator|provisioning|user-management-orchestrator" \
  "medicitas_catalog|catalog|catalog-service-management" \
  "medicitas_scheduler|scheduling|scheduler-management" \
  "medicitas_appointment_orchestrator|booking|appointment-orchestrator"
do
  db=$(echo "$entry" | cut -d'|' -f1)
  schema=$(echo "$entry" | cut -d'|' -f2)
  service=$(echo "$entry" | cut -d'|' -f3)
  echo
  echo "## ${service} — database \`${db}\`, schema \`${schema}\`"
  psql --no-psqlrc -q -At -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$db" \
       -v schema="$schema" -v first="$([ "$db" = medicitas_tenant ] && echo true || echo false)" <<'SQL'
SELECT string_agg(md, E'\n' ORDER BY relname)
FROM (
    SELECT c.relname,
           format(E'\n### `%s`\n\n%s\n\n| Column | Type | Null | Default | Description |\n|---|---|:-:|---|---|\n%s\n\n**Constraints**\n\n%s\n\n**Indexes**\n\n%s\n\n**Row-Level Security**: %s\n',
               c.relname,
               coalesce(obj_description(c.oid, 'pg_class'), '—'),
               (SELECT string_agg(format('| `%s` | `%s` | %s | %s | %s |',
                                         a.attname,
                                         format_type(a.atttypid, a.atttypmod),
                                         CASE WHEN a.attnotnull THEN 'no' ELSE 'yes' END,
                                         replace(coalesce('`' || pg_get_expr(d.adbin, d.adrelid) || '`', ''), '|', '\|'),
                                         replace(coalesce(col_description(c.oid, a.attnum), ''), '|', '\|')),
                                  E'\n' ORDER BY a.attnum)
                FROM pg_attribute a
                LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
               coalesce((SELECT string_agg(format('- `%s`: `%s`', con.conname, pg_get_constraintdef(con.oid)),
                                           E'\n' ORDER BY con.conname)
                         FROM pg_constraint con WHERE con.conrelid = c.oid AND con.contype <> 'n'), '—'),
               coalesce((SELECT string_agg(format('- `%s`: `%s`%s', i.relname, pg_get_indexdef(i.oid),
                                                  coalesce(' — ' || obj_description(i.oid, 'pg_class'), '')),
                                           E'\n' ORDER BY i.relname)
                         FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
                         WHERE x.indrelid = c.oid), '—'),
               CASE WHEN c.relrowsecurity THEN 'enabled' || CASE WHEN c.relforcerowsecurity THEN ' + forced' ELSE '' END
                    || ' — policies: ' || coalesce((SELECT string_agg(format('`%s` (%s%s)', p.polname,
                                                    CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                                                         WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
                                                    CASE WHEN p.polpermissive THEN '' ELSE ', restrictive' END),
                                                    ', ' ORDER BY p.polname)
                                                  FROM pg_policy p WHERE p.polrelid = c.oid), 'none')
                    ELSE 'not enabled (control-plane or reference table)' END
           ) AS md
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname = :'schema'
      AND c.relname <> 'flyway_schema_history'
      AND (:'first'::boolean OR c.relname NOT IN ('outbox_messages', 'inbox_messages', 'idempotency_records'))
) t;
SQL
done
