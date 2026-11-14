#!/usr/bin/env node
// =============================================================================
// Module 2 — RLS as a second strategy, compared with the
// discriminator column on the SAME queries and the SAME data.
//
//   Mode A — discriminator only : role sch_bench_norls (BYPASSRLS, test-only), WHERE tenant_id = $1
//   Mode B — RLS only           : runtime actor role, NO tenant predicate (the policy alone isolates)
//   Mode C — both (production)  : runtime actor role, WHERE tenant_id = $1, plus the policy
//
// Measured: server-side execution and planning time of EXPLAIN (ANALYZE, BUFFERS) over repeated runs
// (median, p95), rows, shared buffers and the indexes each plan uses; plus leak tests (a "buggy" query
// without the tenant predicate, absent and malformed context).
//
// Two datasets: the seed as it is, and the seed + synthetic history (~20,000 appointments and ~20,000
// audit rows per seeded clinic). EVERYTHING runs inside one transaction that is ROLLED BACK: nothing is
// left in the database. It connects as the PostgreSQL superuser of the local stack (from .env) only to
// switch roles with SET LOCAL ROLE and to disable the booking validation trigger for the bulk load.
//
//   node metrics/bench-multitenancy.mjs [--runs 60] [--out metrics/results/multitenancy-benchmark.json]
// =============================================================================
import { existsSync, writeFileSync } from 'node:fs';
import pg from 'pg';

if (existsSync('.env')) process.loadEnvFile('.env');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const RUNS = Number(arg('runs', '60'));
const WARMUP = 5;
const OUT = arg('out', 'metrics/results/multitenancy-benchmark.json');

const TENANT = '10000000-0000-4000-8000-000000000001';
const OTHER_TENANTS = ['10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003'];
const PROFESSIONAL = '42000000-0000-4000-8000-000000010001';
const SERVICE = '41000000-0000-4000-8000-000000010001';

const client = new pg.Client({
  host: '127.0.0.1',
  port: Number(process.env.POSTGRES_HOST_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: 'medicitas_scheduler',
  application_name: 'bench-multitenancy',
});

// {{T:alias}} → the tenant predicate of each mode. $1 is always the tenant id, so every mode binds the
// same parameters; mode B replaces the predicate by a tautology that still references $1.
const predicate = (mode, alias) => (mode === 'B' ? '($1::uuid IS NOT NULL)' : `${alias}.tenant_id = $1`);
const render = (sql, mode) => sql.replace(/\{\{T:(\w+)\}\}/g, (_, alias) => predicate(mode, alias));

const QUERIES = [
  {
    id: 'RF7',
    title: 'RF7 availability of one professional on one day (inlined compute_available_slots)',
    role: 'sch_receptionist',
    params: (ctx) => [TENANT, PROFESSIONAL, SERVICE, ctx.day],
    sql: `
WITH ctx AS (
  SELECT t.timezone AS tz, s.duration_minutes AS duration, st.slot_step_minutes AS step
  FROM tenants t
  JOIN catalog_services s ON s.tenant_id = t.id AND s.id = $3 AND s.status = 'active'
  JOIN catalog_professionals p ON p.tenant_id = t.id AND p.id = $2 AND p.status = 'active'
  JOIN catalog_professional_services ps ON ps.tenant_id = t.id AND ps.professional_id = p.id AND ps.service_id = s.id
  CROSS JOIN scheduling_settings st
  WHERE {{T:s}} AND t.id = $1
), working_blocks AS (
  SELECT ($4::date + b.start_time) AT TIME ZONE ctx.tz AS block_start, ($4::date + b.end_time) AT TIME ZONE ctx.tz AS block_end, ctx.duration, ctx.step
  FROM weekly_schedule_blocks b CROSS JOIN ctx
  WHERE {{T:b}} AND b.professional_id = $2 AND b.day_of_week = extract(isodow FROM $4::date)
), candidates AS (
  SELECT g AS start_at, g + make_interval(mins => wb.duration) AS end_at
  FROM working_blocks wb
  CROSS JOIN LATERAL generate_series(wb.block_start, wb.block_end - make_interval(mins => wb.duration), make_interval(mins => wb.step)) AS g
)
SELECT c.start_at, c.end_at FROM candidates c
WHERE NOT EXISTS (SELECT 1 FROM appointments a
                  WHERE {{T:a}} AND a.professional_id = $2 AND a.status IN ('held', 'booked')
                    AND a.starts_at >= (SELECT $4::date::timestamp AT TIME ZONE t.timezone FROM tenants t WHERE t.id = $1)
                    AND a.starts_at <  (SELECT ($4::date + 1)::timestamp AT TIME ZONE t.timezone FROM tenants t WHERE t.id = $1)
                    AND a.starts_at < c.end_at AND a.ends_at > c.start_at)
  AND NOT EXISTS (SELECT 1 FROM calendar_blocks cb
                  WHERE {{T:cb}} AND cb.professional_id = $2 AND cb.status = 'active' AND cb.period && tstzrange(c.start_at, c.end_at, '[)'))
ORDER BY c.start_at`,
  },
  {
    id: 'RF16',
    title: 'RF16 history of one patient, newest first',
    role: 'sch_receptionist',
    params: (ctx) => [TENANT, ctx.patient],
    sql: `SELECT a.id, a.professional_id, a.service_id, a.slot, a.status FROM appointments a
          WHERE {{T:a}} AND a.patient_id = $2 ORDER BY a.starts_at DESC LIMIT 20`,
  },
  {
    id: 'RF20',
    title: 'RF20 clinic-wide agenda of one day',
    role: 'sch_receptionist',
    params: (ctx) => [TENANT, ctx.day],
    sql: `SELECT a.id, a.slot, a.status, a.patient_id, a.professional_id, p.display_name, s.name
          FROM appointments a
          JOIN catalog_professionals p ON p.tenant_id = a.tenant_id AND p.id = a.professional_id
          JOIN catalog_services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id
          WHERE {{T:a}} AND a.starts_at >= ($2::date)::timestamp AT TIME ZONE 'America/Costa_Rica'
            AND a.starts_at < ($2::date + 1)::timestamp AT TIME ZONE 'America/Costa_Rica'
            AND a.status NOT IN ('held', 'released')
          ORDER BY a.starts_at, p.display_name`,
  },
  {
    id: 'RF21',
    title: 'RF21 counts by status over 365 days',
    role: 'sch_receptionist',
    params: (ctx) => [TENANT, ctx.day],
    sql: `SELECT a.status, count(*) FROM appointments a
          WHERE {{T:a}} AND a.starts_at >= ($2::date - 365)::timestamp AT TIME ZONE 'America/Costa_Rica'
            AND a.starts_at < ($2::date)::timestamp AT TIME ZONE 'America/Costa_Rica'
            AND a.status NOT IN ('held', 'released')
          GROUP BY a.status`,
  },
  {
    id: 'RF19',
    title: 'RF19 audit log of one patient, newest first',
    role: 'sch_clinic_admin',
    params: (ctx) => [TENANT, ctx.auditPatient],
    sql: `SELECT l.id, l.occurred_at, l.actor_subject, l.action, l.resource_type FROM audit_log l
          WHERE {{T:l}} AND l.patient_id = $2 ORDER BY l.occurred_at DESC LIMIT 50`,
  },
];

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};
const round = (value) => Math.round(value * 1000) / 1000;

function walk(node, visit) {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

async function asRole(role, tenant, work) {
  await client.query('SAVEPOINT bench');
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_subject', '', true)`, [tenant ?? '']);
    return await work();
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT bench');
    await client.query('RESET ROLE');
  }
}

async function measure(query, mode, ctx) {
  const role = mode === 'A' ? 'sch_bench_norls' : query.role;
  const sql = render(query.sql, mode);
  const params = query.params(ctx);
  return asRole(role, mode === 'A' ? null : TENANT, async () => {
    const execution = [];
    const planning = [];
    let sample;
    for (let run = 0; run < WARMUP + RUNS; run += 1) {
      const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
      const plan = result.rows[0]['QUERY PLAN'][0];
      if (run >= WARMUP) {
        execution.push(plan['Execution Time']);
        planning.push(plan['Planning Time']);
      }
      sample = plan;
    }
    const indexes = new Set();
    let sharedHit = 0;
    let rlsFilter = false;
    walk(sample.Plan, (node) => {
      if (node['Index Name'] !== undefined) indexes.add(node['Index Name']);
      sharedHit += node['Shared Hit Blocks'] ?? 0;
      if (JSON.stringify(node).includes('current_tenant_id')) rlsFilter = true;
    });
    const rows = (await client.query(sql, params)).rowCount;
    return {
      query: query.id,
      mode,
      role,
      rows,
      executionMedianMs: round(median(execution)),
      executionP95Ms: round(p95(execution)),
      planningMedianMs: round(median(planning)),
      sharedHitBlocks: sample.Plan['Shared Hit Blocks'],
      indexes: [...indexes].sort(),
      policyInPlan: rlsFilter,
    };
  });
}

/** Leak tests: the same "buggy" query (no tenant predicate) under each strategy. */
async function leakTests(ctx) {
  const buggy = `SELECT count(*) AS n, count(DISTINCT tenant_id) AS tenants FROM appointments WHERE starts_at >= ($1::date - 3650) AND patient_id IS NOT NULL`;
  const out = {};
  out.discriminatorOnlyForgotPredicate = await asRole('sch_bench_norls', null, async () => (await client.query(buggy, [ctx.day])).rows[0]);
  out.rlsForgotPredicate = await asRole('sch_receptionist', TENANT, async () => (await client.query(buggy, [ctx.day])).rows[0]);
  out.rlsAbsentContext = await asRole('sch_receptionist', null, async () => (await client.query(buggy, [ctx.day])).rows[0]);
  out.rlsMalformedContext = await asRole('sch_receptionist', null, async () => {
    try {
      await client.query(`SELECT set_config('app.tenant_id', 'not-a-uuid', true)`);
      await client.query(buggy, [ctx.day]);
      return { error: null };
    } catch (error) {
      return { error: error.code };
    }
  });
  out.rlsExplicitForeignTenant = await asRole('sch_receptionist', TENANT, async () =>
    (await client.query(`SELECT count(*) AS n FROM appointments WHERE tenant_id = ANY($1::uuid[])`, [OTHER_TENANTS])).rows[0],
  );
  for (const key of Object.keys(out)) {
    for (const [field, value] of Object.entries(out[key])) if (typeof value === 'string' && /^\d+$/.test(value)) out[key][field] = Number(value);
  }
  return out;
}

async function sizes() {
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM appointments) AS appointments, (SELECT count(*) FROM audit_log) AS audit_rows,
            (SELECT count(*) FROM appointments WHERE tenant_id = $1) AS appointments_tenant,
            (SELECT count(*) FROM audit_log WHERE tenant_id = $1) AS audit_tenant`,
    [TENANT],
  );
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)]));
}

async function context() {
  const day = (await client.query(`SELECT ((now() AT TIME ZONE 'America/Costa_Rica')::date + (8 - extract(isodow FROM (now() AT TIME ZONE 'America/Costa_Rica')::date))::int)::text AS day`)).rows[0].day;
  const patient = (await client.query(`SELECT patient_id FROM appointments WHERE tenant_id = $1 GROUP BY patient_id ORDER BY count(*) DESC, patient_id LIMIT 1`, [TENANT])).rows[0].patient_id;
  const auditPatient = (await client.query(`SELECT patient_id FROM audit_log WHERE tenant_id = $1 GROUP BY patient_id ORDER BY count(*) DESC, patient_id LIMIT 1`, [TENANT])).rows[0].patient_id;
  return { day, patient, auditPatient };
}

/** ~20,000 past appointments and ~20,000 audit rows per seeded clinic (history that a real clinic accumulates). */
async function loadVolume() {
  await client.query('ALTER TABLE scheduling.appointments DISABLE TRIGGER appointments_validate_insert');
  await client.query(`
    WITH pros AS (
      SELECT p.tenant_id, p.id AS professional_id, t.timezone,
             (SELECT ps.service_id FROM catalog_professional_services ps JOIN catalog_services s ON s.tenant_id = ps.tenant_id AND s.id = ps.service_id
               WHERE ps.tenant_id = p.tenant_id AND ps.professional_id = p.id AND s.duration_minutes <= 60 ORDER BY s.duration_minutes LIMIT 1) AS service_id,
             (SELECT s.duration_minutes FROM catalog_professional_services ps JOIN catalog_services s ON s.tenant_id = ps.tenant_id AND s.id = ps.service_id
               WHERE ps.tenant_id = p.tenant_id AND ps.professional_id = p.id AND s.duration_minutes <= 60 ORDER BY s.duration_minutes LIMIT 1) AS duration,
             row_number() OVER (PARTITION BY p.tenant_id ORDER BY p.id) AS n
      FROM catalog_professionals p JOIN tenants t ON t.id = p.tenant_id
      WHERE p.id::text LIKE '42000000-%'
    )
    INSERT INTO appointments (id, tenant_id, patient_id, professional_id, service_id, slot, status, booked_by_subject,
                              outcome_recorded_by_subject, outcome_recorded_at, cancel_reason, cancelled_by_subject, cancelled_at)
    SELECT gen_random_uuid(), pros.tenant_id,
           md5(pros.professional_id::text || ((d * 8 + k) % 250)::text)::uuid,
           pros.professional_id, pros.service_id,
           tstzrange(ts, ts + make_interval(mins => pros.duration), '[)'), st.status, gen_random_uuid(),
           CASE WHEN st.status IN ('attended', 'no_show') THEN gen_random_uuid() END,
           CASE WHEN st.status IN ('attended', 'no_show') THEN ts + interval '1 hour' END,
           CASE WHEN st.status = 'cancelled' THEN 'synthetic history' END,
           CASE WHEN st.status = 'cancelled' THEN gen_random_uuid() END,
           CASE WHEN st.status = 'cancelled' THEN ts - interval '1 day' END
    FROM pros, generate_series(167, 1000) AS d, generate_series(0, 7) AS k,
         LATERAL (SELECT ((current_date - d)::timestamp + time '07:00' + k * interval '60 minutes') AT TIME ZONE pros.timezone AS ts) x,
         LATERAL (SELECT (ARRAY['attended', 'attended', 'attended', 'no_show', 'cancelled', 'booked'])[1 + ((d + k) % 6)] AS status) st
    WHERE pros.service_id IS NOT NULL
    ON CONFLICT DO NOTHING`);
  await client.query(`
    INSERT INTO audit_log (tenant_id, occurred_at, actor_subject, actor_role, patient_id, resource_type, resource_id, action, outcome, correlation_id, source_service)
    SELECT t.id, now() - (g % 365) * interval '1 day' - (g % 1440) * interval '1 minute',
           md5(t.id::text || (g % 12)::text)::uuid,
           (ARRAY['clinic_admin', 'receptionist', 'health_professional'])[1 + g % 3],
           md5(t.id::text || 'p' || (g % 1500)::text)::uuid,
           (ARRAY['clinical_note', 'patient_contact'])[1 + g % 2], gen_random_uuid(),
           (ARRAY['read', 'read', 'create', 'update'])[1 + g % 4], (ARRAY['success', 'success', 'success', 'denied'])[1 + g % 4],
           gen_random_uuid(), 'scheduler-management'
    FROM tenants t, generate_series(1, 20000) AS g
    WHERE t.id::text LIKE '10000000-%'`);
  await client.query('ANALYZE scheduling.appointments');
  await client.query('ANALYZE scheduling.audit_log');
}

async function runDataset(name) {
  const ctx = await context();
  const results = [];
  for (const query of QUERIES) for (const mode of ['A', 'B', 'C']) results.push(await measure(query, mode, ctx));
  return { dataset: name, sizes: await sizes(), context: ctx, results, leaks: await leakTests(ctx) };
}

function printDataset(report) {
  console.log(`\n## Dataset: ${report.dataset} — ${report.sizes.appointments} appointments (${report.sizes.appointments_tenant} in clinic 1), ${report.sizes.audit_rows} audit rows`);
  console.log('| Query | Mode | Rows | Exec median ms | Exec p95 ms | Plan median ms | Shared hit | Indexes |');
  console.log('|---|---|--:|--:|--:|--:|--:|---|');
  for (const row of report.results) {
    console.log(`| ${row.query} | ${row.mode} | ${row.rows} | ${row.executionMedianMs} | ${row.executionP95Ms} | ${row.planningMedianMs} | ${row.sharedHitBlocks} | ${row.indexes.join(', ')} |`);
  }
  console.log('Leak tests:', JSON.stringify(report.leaks));
}

await client.connect();
const reports = [];
try {
  await client.query('BEGIN');
  await client.query('SET LOCAL search_path TO scheduling, app, public');
  const server = (await client.query('SHOW server_version')).rows[0].server_version;
  const jit = (await client.query('SHOW jit')).rows[0].jit;
  console.log(`PostgreSQL ${server}, jit=${jit}, ${RUNS} runs per mode after ${WARMUP} warm-up runs`);
  reports.push(await runDataset('seed'));
  printDataset(reports[0]);
  await loadVolume();
  reports.push(await runDataset('seed + synthetic history'));
  printDataset(reports[1]);
  writeFileSync(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), postgres: server, jit, runsPerMode: RUNS, warmup: WARMUP, reports }, null, 2)}\n`);
  console.log(`\nEvidence written to ${OUT}`);
} finally {
  await client.query('ROLLBACK');
  await client.end();
}
