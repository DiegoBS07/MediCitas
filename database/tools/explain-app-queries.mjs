#!/usr/bin/env node
// =============================================================================
// Final index evidence (Stage 7): EXPLAIN (ANALYZE, BUFFERS) of the EXACT SQL the services run (copied
// from the repositories), on the production path — actor role via SET LOCAL ROLE and app.tenant_id via
// set_config, so discriminator + RLS — with the seed and with synthetic history (~20,000 appointments,
// ~20,000 audit rows and ~20,000 patients per seeded clinic). Everything is ROLLED BACK.
//
//   node database/tools/explain-app-queries.mjs [--out docs/data/evidence/explain-app-queries.txt]
// =============================================================================
import { existsSync, writeFileSync } from 'node:fs';
import pg from 'pg';

if (existsSync('.env')) process.loadEnvFile('.env');
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'docs/data/evidence/explain-app-queries.txt';

const TENANT = '10000000-0000-4000-8000-000000000001';
const PROFESSIONAL = '42000000-0000-4000-8000-000000010001';
const SERVICE = '41000000-0000-4000-8000-000000010001';
const lines = [];
const log = (text = '') => {
  lines.push(text);
  console.log(text);
};

const connect = (database) =>
  new pg.Client({
    host: '127.0.0.1',
    port: Number(process.env.POSTGRES_HOST_PORT ?? 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database,
    application_name: 'explain-app-queries',
  });

async function explain(client, { title, role, tenant, sql, params }) {
  await client.query('SAVEPOINT q');
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_subject', '', true)`, [tenant ?? '']);
    for (let warm = 0; warm < 3; warm += 1) await client.query(sql, params);
    const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) ${sql}`, params);
    log(`--- ${title}  [role ${role}${tenant === null ? ', no tenant context' : ''}]`);
    for (const row of rows) log(row['QUERY PLAN']);
    log();
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT q');
    await client.query('RESET ROLE');
  }
}

// ---------------------------------------------------------------- scheduler
const SCHEDULER_QUERIES = (ctx) => [
  {
    title: 'RF7 availability context (pg-read-repository availabilityContext)',
    role: 'sch_receptionist',
    tenant: TENANT,
    params: [PROFESSIONAL, SERVICE, ctx.day],
    sql: `SELECT t.timezone,
              to_char((now() AT TIME ZONE t.timezone)::date, 'YYYY-MM-DD') AS today,
              to_char((now() AT TIME ZONE t.timezone)::date + st.booking_horizon_days, 'YYYY-MM-DD') AS horizon,
              now() AS now, st.slot_step_minutes AS step,
              p.status AS p_status, p.display_name AS p_name, ag.schedule_version,
              s.status AS s_status, s.duration_minutes AS s_duration, s.version AS s_version,
              EXISTS (SELECT 1 FROM catalog_professional_services ps WHERE ps.professional_id = $1 AND ps.service_id = $2) AS offers,
              (SELECT av.version FROM availability_versions av WHERE av.professional_id = $1 AND av.local_date = $3::date) AS date_version
       FROM tenants t
       CROSS JOIN scheduling_settings st
       LEFT JOIN catalog_professionals p ON p.id = $1
       LEFT JOIN professional_agendas ag ON ag.professional_id = $1
       LEFT JOIN catalog_services s ON s.id = $2
       WHERE t.id = app.current_tenant_id()`,
  },
  {
    title: 'RF7 slots (pg-read-repository computeSlots → compute_available_slots, inlined by the planner)',
    role: 'sch_receptionist',
    tenant: TENANT,
    params: [PROFESSIONAL, SERVICE, ctx.day],
    sql: `SELECT c.start_at, c.end_at, to_char(c.start_at AT TIME ZONE t.timezone, 'HH24:MI') AS local_start
       FROM compute_available_slots($1, $2, $3::date) c
       CROSS JOIN tenants t WHERE t.id = app.current_tenant_id()
       ORDER BY c.start_at`,
  },
  {
    title: 'RF8 professionals offering a service (activeProfessionalsOffering)',
    role: 'sch_receptionist',
    tenant: TENANT,
    params: [SERVICE],
    sql: `SELECT p.id, p.display_name FROM catalog_professionals p
       JOIN catalog_professional_services ps ON ps.professional_id = p.id AND ps.tenant_id = p.tenant_id
       WHERE ps.service_id = $1 AND p.status = 'active'
       ORDER BY p.display_name, p.id`,
  },
  ...[
    ['RF19 audit log filtered by patient', [null, ctx.auditPatient, null, null, null, null, 50]],
    ['RF19 audit log filtered by user (actor)', [ctx.auditActor, null, null, null, null, null, 50]],
    ['RF19 audit log by date range only (last 7 days)', [null, null, ctx.weekAgo, null, null, null, 50]],
  ].map(([title, params]) => ({
    title: `${title} (pg-read-repository auditLog)`,
    role: 'sch_clinic_admin',
    tenant: TENANT,
    params,
    sql: `SELECT id, occurred_at, actor_subject, actor_role, patient_id, resource_type, resource_id, action, outcome, correlation_id, source_service
       FROM audit_log
       WHERE ($1::uuid IS NULL OR actor_subject = $1)
         AND ($2::uuid IS NULL OR patient_id = $2)
         AND ($3::timestamptz IS NULL OR occurred_at >= $3)
         AND ($4::timestamptz IS NULL OR occurred_at < $4)
         AND ($5::text IS NULL OR action = $5)
         AND ($6::text IS NULL OR resource_type = $6)
       ORDER BY occurred_at DESC, id DESC
       LIMIT $7`,
  })),
  {
    title: 'Hold-expiry sweeper discovery (cross-tenant worker role)',
    role: 'sch_worker',
    tenant: null,
    params: [],
    sql: `SELECT id, tenant_id FROM appointments WHERE status = 'held' AND hold_expires_at <= now() ORDER BY hold_expires_at LIMIT 100`,
  },
];

async function schedulerVolume(client) {
  await client.query('ALTER TABLE scheduling.appointments DISABLE TRIGGER appointments_validate_insert');
  await client.query(`
    WITH pros AS (
      SELECT p.tenant_id, p.id AS professional_id, t.timezone, sv.service_id, sv.duration
      FROM catalog_professionals p JOIN tenants t ON t.id = p.tenant_id
      CROSS JOIN LATERAL (SELECT ps.service_id, s.duration_minutes AS duration FROM catalog_professional_services ps
                          JOIN catalog_services s ON s.tenant_id = ps.tenant_id AND s.id = ps.service_id
                          WHERE ps.tenant_id = p.tenant_id AND ps.professional_id = p.id AND s.duration_minutes <= 60
                          ORDER BY s.duration_minutes LIMIT 1) sv
      WHERE p.id::text LIKE '42000000-%'
    )
    INSERT INTO appointments (id, tenant_id, patient_id, professional_id, service_id, slot, status, booked_by_subject,
                              outcome_recorded_by_subject, outcome_recorded_at, cancel_reason, cancelled_by_subject, cancelled_at)
    SELECT gen_random_uuid(), pros.tenant_id, md5(pros.professional_id::text || ((d * 8 + k) % 250)::text)::uuid,
           pros.professional_id, pros.service_id, tstzrange(ts, ts + make_interval(mins => pros.duration), '[)'), st.status, gen_random_uuid(),
           CASE WHEN st.status IN ('attended', 'no_show') THEN gen_random_uuid() END, CASE WHEN st.status IN ('attended', 'no_show') THEN ts + interval '1 hour' END,
           CASE WHEN st.status = 'cancelled' THEN 'synthetic history' END, CASE WHEN st.status = 'cancelled' THEN gen_random_uuid() END,
           CASE WHEN st.status = 'cancelled' THEN ts - interval '1 day' END
    FROM pros, generate_series(167, 1000) AS d, generate_series(0, 7) AS k,
         LATERAL (SELECT ((current_date - d)::timestamp + time '07:00' + k * interval '60 minutes') AT TIME ZONE pros.timezone AS ts) x,
         LATERAL (SELECT (ARRAY['attended', 'attended', 'attended', 'no_show', 'cancelled', 'booked'])[1 + ((d + k) % 6)] AS status) st
    ON CONFLICT DO NOTHING`);
  await client.query(`
    INSERT INTO audit_log (tenant_id, occurred_at, actor_subject, actor_role, patient_id, resource_type, resource_id, action, outcome, correlation_id, source_service)
    SELECT t.id, now() - (g % 365) * interval '1 day' - (g % 1440) * interval '1 minute', md5(t.id::text || (g % 12)::text)::uuid,
           (ARRAY['clinic_admin', 'receptionist', 'health_professional'])[1 + g % 3], md5(t.id::text || 'p' || (g % 1500)::text)::uuid,
           (ARRAY['clinical_note', 'patient_contact'])[1 + g % 2], gen_random_uuid(), (ARRAY['read', 'read', 'create', 'update'])[1 + g % 4],
           (ARRAY['success', 'success', 'success', 'denied'])[1 + g % 4], gen_random_uuid(), 'scheduler-management'
    FROM tenants t, generate_series(1, 20000) AS g WHERE t.id::text LIKE '10000000-%'`);
  await client.query('ANALYZE scheduling.appointments');
  await client.query('ANALYZE scheduling.audit_log');
}

async function schedulerContext(client) {
  const { rows } = await client.query(
    `SELECT ((now() AT TIME ZONE 'America/Costa_Rica')::date + (8 - extract(isodow FROM (now() AT TIME ZONE 'America/Costa_Rica')::date))::int)::text AS day,
            (SELECT patient_id FROM audit_log WHERE tenant_id = $1 GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1) AS audit_patient,
            (SELECT actor_subject FROM audit_log WHERE tenant_id = $1 GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1) AS audit_actor,
            now() - interval '7 days' AS week_ago,
            (SELECT count(*) FROM appointments WHERE tenant_id = $1) AS appointments,
            (SELECT count(*) FROM audit_log WHERE tenant_id = $1) AS audit_rows`,
    [TENANT],
  );
  const row = rows[0];
  return { day: row.day, auditPatient: row.audit_patient, auditActor: row.audit_actor, weekAgo: row.week_ago, sizes: `clinic 1: ${row.appointments} appointments, ${row.audit_rows} audit rows` };
}

// ---------------------------------------------------------------- user-management
const USER_QUERIES = [
  ['RF14 patient search, prefix "mor" (pg-repositories list)', ['mor%', 'mor%', 21]],
  ['RF14 patient list without search (first page)', [null, null, 21]],
].map(([title, params]) => ({
  title,
  role: 'um_receptionist',
  tenant: TENANT,
  params,
  sql: `SELECT id, tenant_id, identification_type, identification_number, first_name, last_name,
              to_char(birth_date, 'YYYY-MM-DD') AS birth_date, NULL::text AS email, NULL::text AS phone,
              NULL::text AS address, status, created_by_subject, version, created_at, updated_at FROM patients
       WHERE ($1::text IS NULL OR search_last_name LIKE $1 OR search_first_name LIKE $1 OR identification_number LIKE $2)
       ORDER BY search_last_name, id
       LIMIT $3`,
}));

async function userVolume(client) {
  await client.query(`
    INSERT INTO patients (id, tenant_id, identification_type, identification_number, first_name, last_name, birth_date, created_by_subject)
    SELECT gen_random_uuid(), t.id, 'passport', 'SYN-' || g, (ARRAY['Ana', 'Luis', 'María', 'José', 'Sofía', 'Carlos'])[1 + g % 6],
           (ARRAY['Mora', 'Rojas', 'Vargas', 'Jiménez', 'Castro', 'Araya', 'Quesada', 'Solano', 'Méndez', 'Chaves'])[1 + g % 10] || ' ' || g,
           date '1950-01-01' + (g % 20000), gen_random_uuid()
    FROM tenants t, generate_series(1, 20000) AS g WHERE t.id::text LIKE '10000000-%'`);
  await client.query('ANALYZE identity.patients');
}

async function run(database, searchPath, queries, volume, context) {
  const client = connect(database);
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${searchPath}, app, public`);
    for (const dataset of ['seed', 'seed + synthetic history']) {
      if (dataset !== 'seed') await volume(client);
      const ctx = await context(client);
      log(`==================== ${database} — dataset: ${dataset}${ctx.sizes === undefined ? '' : ` (${ctx.sizes})`}`);
      for (const query of queries(ctx)) await explain(client, query);
    }
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}

log(`# EXPLAIN (ANALYZE, BUFFERS) of the services' exact SQL — generated ${new Date().toISOString()}`);
log('# Production path: SET LOCAL ROLE <actor role>, app.tenant_id via set_config (discriminator + RLS). All data changes rolled back.');
log();
await run('medicitas_scheduler', 'scheduling', SCHEDULER_QUERIES, schedulerVolume, schedulerContext);
await run(
  'medicitas_user',
  'identity',
  () => USER_QUERIES,
  userVolume,
  async (client) => {
    const { rows } = await client.query('SELECT count(*) AS n FROM patients WHERE tenant_id = $1', [TENANT]);
    return { sizes: `clinic 1: ${rows[0].n} patients` };
  },
);
writeFileSync(OUT, `${lines.join('\n')}\n`);
console.log(`Evidence written to ${OUT}`);
