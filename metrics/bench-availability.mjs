#!/usr/bin/env node
// =============================================================================
// Availability cache: measurement BEFORE and AFTER the cache.
// End to end through the API gateway, as a client sees it (gateway + JWT + scheduler + Redis/PostgreSQL).
//
//   Phase 1 — "after":  cache enabled (default). Responses are classified by X-Cache (MISS / HIT).
//   Phase 2 — "before": the scheduler container is restarted with AVAILABILITY_CACHE_ENABLED=false,
//                       so every request computes from PostgreSQL (X-Cache: BYPASS); then it is
//                       restarted again with the configured value.
//
// Read-only for business data (only RF7/RF8 queries on the seeded clinic 1). Never prints tokens.
//   node metrics/bench-availability.mjs [--requests 300] [--concurrency 10] [--skip-before]
//   npm run bench:cache
// =============================================================================
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const REQUESTS = Number(arg('requests', '300'));
const CONCURRENCY = Number(arg('concurrency', '10'));
const SKIP_BEFORE = process.argv.includes('--skip-before');
const OUT = arg('out', 'metrics/results/availability-cache-benchmark.json');
const GATEWAY = `http://127.0.0.1:${process.env.GATEWAY_HOST_PORT ?? '8000'}`;
const TZ = 'America/Costa_Rica';

const token = await (async () => {
  const response = await fetch(`${process.env.KEYCLOAK_PUBLIC_URL}/realms/medicitas/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'medicitas-cli', username: 'carlos.jimenez@sanjose.medicitas.test', password: process.env.MEDICITAS_DEMO_USER_PASSWORD ?? '' }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`token request failed with HTTP ${response.status}`);
  return body.access_token;
})();

async function get(path, retried = false) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(`${GATEWAY}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  } catch (error) {
    // A pooled keep-alive socket closed by the server while idle: retry the idempotent GET once.
    if (!retried && error instanceof TypeError) return get(path, true);
    throw error;
  }
  await response.arrayBuffer();
  if (response.status !== 200) throw new Error(`${path} → HTTP ${response.status}`);
  return { ms: performance.now() - started, cache: response.headers.get('x-cache') ?? 'n/a' };
}

const localDate = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + days * 86_400_000));
const SEEDED_PAIRS = [
  ['42000000-0000-4000-8000-000000010001', '41000000-0000-4000-8000-000000010001'],
  ['42000000-0000-4000-8000-000000010002', '41000000-0000-4000-8000-000000010003'],
  ['42000000-0000-4000-8000-000000010003', '41000000-0000-4000-8000-000000010005'],
];
const rf7 = (index) => {
  const [professional, service] = SEEDED_PAIRS[index % SEEDED_PAIRS.length];
  return `/api/v1/availability?professionalId=${professional}&serviceId=${service}&date=${localDate(1 + (index % 170))}`;
};
const rf8 = (index) => `/api/v1/availability/search?serviceId=41000000-0000-4000-8000-000000010001&from=${localDate(1 + (index % 160))}&to=${localDate(14 + (index % 160))}`;

function stats(samples) {
  if (samples.length === 0) return null;
  const sorted = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)];
  const round = (value) => Math.round(value * 100) / 100;
  return { n: sorted.length, p50: round(pick(0.5)), p95: round(pick(0.95)), p99: round(pick(0.99)), mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length) };
}

async function sequential(paths) {
  const samples = [];
  for (const path of paths) samples.push(await get(path));
  return samples;
}

async function concurrent(paths) {
  const queue = [...paths];
  const samples = [];
  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) samples.push(await get(path));
  }));
  return { samples, throughput: Math.round((samples.length / ((performance.now() - started) / 1000)) * 10) / 10 };
}

const byCache = (samples, value) => samples.filter((sample) => sample.cache === value);

async function phase(label) {
  // Warm the connection pools and the JWKS cache first (not measured).
  await sequential(Array.from({ length: 20 }, (_, index) => rf7(1000 + index)));
  const distinct = Array.from({ length: REQUESTS }, (_, index) => rf7(index)); // ≈ first touch of each key
  const first = await sequential(distinct);
  const repeated = await sequential(Array.from({ length: REQUESTS }, () => rf7(7))); // one hot key
  const search = await sequential(Array.from({ length: Math.min(REQUESTS, 100) }, (_, index) => rf8(index)));
  const searchAgain = await sequential(Array.from({ length: Math.min(REQUESTS, 100) }, (_, index) => rf8(index)));
  const load = await concurrent(Array.from({ length: REQUESTS }, () => rf7(7)));
  const all = [...first, ...repeated];
  return {
    label,
    rf7: {
      miss: stats(byCache(all, 'MISS')),
      hit: stats(byCache(all, 'HIT')),
      bypass: stats(byCache(all, 'BYPASS')),
      hitRateOnRepeatedKey: Math.round((byCache(repeated, 'HIT').length / repeated.length) * 1000) / 10,
    },
    rf8: { firstTouch: stats(search), repeated: stats(searchAgain) },
    concurrentHotKey: { concurrency: CONCURRENCY, throughputPerSecond: load.throughput, latency: stats(load.samples), cache: [...new Set(load.samples.map((sample) => sample.cache))] },
  };
}

function compose(args, env = process.env) {
  execFileSync('docker', ['compose', ...args], { cwd: process.cwd(), env, stdio: 'ignore', timeout: 300_000 });
}

const results = [];
results.push(await phase('after — cache enabled'));
if (!SKIP_BEFORE) {
  try {
    compose(['up', '-d', '--wait', '--no-deps', 'scheduler-management'], { ...process.env, AVAILABILITY_CACHE_ENABLED: 'false' });
    results.push(await phase('before — cache disabled (PostgreSQL only)'));
  } finally {
    compose(['up', '-d', '--wait', '--no-deps', 'scheduler-management']);
  }
}

for (const result of results) {
  console.log(`\n### ${result.label}`);
  console.log('| Measurement | n | p50 ms | p95 ms | p99 ms | mean ms |');
  console.log('|---|--:|--:|--:|--:|--:|');
  const row = (name, s) => s && console.log(`| ${name} | ${s.n} | ${s.p50} | ${s.p95} | ${s.p99} | ${s.mean} |`);
  row('RF7 MISS (computed in PostgreSQL, then cached)', result.rf7.miss);
  row('RF7 HIT (served from Redis)', result.rf7.hit);
  row('RF7 BYPASS (PostgreSQL only)', result.rf7.bypass);
  row('RF8 14-day search, first touch', result.rf8.firstTouch);
  row('RF8 14-day search, repeated', result.rf8.repeated);
  row(`RF7 hot key, ${result.concurrentHotKey.concurrency} concurrent clients`, result.concurrentHotKey.latency);
  console.log(`Hit rate on the repeated key: ${result.rf7.hitRateOnRepeatedKey}% · throughput with ${CONCURRENCY} clients: ${result.concurrentHotKey.throughputPerSecond} req/s (${result.concurrentHotKey.cache.join('/')})`);
}
writeFileSync(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), requests: REQUESTS, concurrency: CONCURRENCY, results }, null, 2)}\n`);
console.log(`\nEvidence written to ${OUT}`);
