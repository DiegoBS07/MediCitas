# Availability cache — design, invariant I8 and measurement before/after

Statement §5.6: RF7 is served from Redis; the group decides the key, the scope of each entry and the invalidation policy, sustains invariant I8 with an automated test that books and queries again, and reports what was measured before and after introducing the cache. The design decision, with the alternatives considered, is in the README (§3, "Availability cache").

## 1. Design (as built)

| Decision | Choice | Why |
|---|---|---|
| What is cached | The RF7 answer of **one professional × one service × one local date** (slots, duration, step, version, `generatedAt`). RF8 is assembled from the same entries (one per professional and day) | RF7 is the most frequent query; one entry per agenda-day keeps invalidation exact |
| Key | `availability:v1:tenant:{tenantId}:professional:{professionalId}:service:{serviceId}:date:{YYYY-MM-DD}:version:{schedule}.{date}.{service}` (the key recommended by the prompt §11, with a composite version, e.g. `4.12.2`); plus an index set `availability:v1:index:tenant:…:professional:…:date:…` listing the keys of one agenda-day | Tenant-scoped (I5), and **versioned**: every input of the computation (weekly schedule and blocks, the day's appointments, the service duration) is part of the key |
| Versions | `availability_versions (tenant, professional, local_date)` bumped in the **same PostgreSQL transaction** as every booking, hold, release, cancellation, reschedule and outcome; `schedule_version` bumped by RF5/RF6; catalog `version` replicated by events | A committed write makes every previous key unreachable *before* the HTTP response is sent — no TTL wait, no race with a late delete |
| Value check | The value repeats tenant, professional, service, date and versions; a value whose identity does not match the request is discarded (treated as a miss) | A manipulated or colliding key can never serve another agenda or tenant |
| Explicit invalidation | `AvailabilityChanged` events (outbox) delete every key listed in the agenda-day index set | Memory hygiene; correctness does not depend on it (the version already changed) |
| TTL | 300 s (`AVAILABILITY_CACHE_TTL_SECONDS`) | Safety net for keys no event deleted; bounds memory together with `maxmemory 96mb allkeys-lru` |
| Redis role | Cache only: no persistence, ACL user restricted to `availability:*` and cache commands | Statement: Redis may not be a primary store |
| Redis down | Fail fast (50 ms command timeout, no offline queue), answer from PostgreSQL with `X-Cache: BYPASS`, log the degradation | Never fake a hit; availability of RF7 does not depend on Redis |

Why not invalidation by timestamp alone, or write-through: timestamps race with late events and clock skew; write-through would put Redis on the booking's critical path and still need a version to reject stale writes.

## 2. I8 evidence (automated)

`tests/acceptance/availability-cache.test.ts`, against the containers:

* MISS then HIT with an identical body.
* **Statement acceptance criterion 5:** query → book one of the returned slots → query again: the slot is gone, the `version` changed and the header is `MISS` (the previous copy is unreachable); the next query is a `HIT` that still excludes the slot. Every served slot is compared with the active rows in PostgreSQL (no overlap).
* Cancel and reschedule free the slot on the very next query (I7); a calendar block and a catalog duration change are visible at once.
* An `AvailabilityChanged` event replayed twice (same `messageId`) and an older one replayed after a newer booking never resurrect a stale view.
* Redis stopped: `X-Cache: BYPASS`, correct data, a booking still excluded at once; Redis back: `MISS` then `HIT`.
* `tests/concurrency/last-slot-race.test.ts`: after every race the slot is gone from availability.

## 3. Measurement before and after

Tool: [`metrics/bench-availability.mjs`](../../metrics/bench-availability.mjs) (`npm run bench:cache`); raw data: [`metrics/results/availability-cache-benchmark.json`](../../metrics/results/availability-cache-benchmark.json). End to end through the gateway (client → gateway → JWT validation → scheduler → Redis/PostgreSQL), clinic 1, seeded professionals, one development machine (12 CPUs, Docker Desktop, all containers on the same host). "Before" = the same scheduler image restarted with `AVAILABILITY_CACHE_ENABLED=false` (every request computes in PostgreSQL); "after" = the default configuration. 300 sequential requests per measurement unless stated.

| Measurement | Before (PostgreSQL only) p50 / p95 ms | After p50 / p95 ms | Change (p50) |
|---|---|---|---|
| RF7, first touch of each key (MISS: compute in PostgreSQL + store in Redis) | 8.01 / 10.58 | 8.09 / 9.53 | ≈ 0 (the extra Redis write is not measurable) |
| RF7, repeated key (HIT, hit rate 100 %) | 8.01 / 10.58 | **5.12 / 6.30** | **−36 %** |
| RF8, 14-day search (sliding windows, 100 requests) | 46.83 / 53.44 | **20.17 / 25.80** | **−57 %** |
| RF7 hot key, 10 concurrent clients (300 requests) | 18.66 / 25.45 | 15.65 / 23.32 | −16 % |
| Throughput, 10 concurrent clients | 505 req/s | 594 req/s | +18 % |

Server-side cost of the RF7 computation itself (module 2 benchmark, `EXPLAIN ANALYZE`): about **0.25 ms execution + 1.7 ms planning** under RLS, plus a second small query for the availability context.

## 4. Analysis

1. **What the cache saves.** A HIT avoids opening a tenant transaction (`BEGIN`, `set_config`, `SET LOCAL ROLE`), two queries (context + slots) and their planning (~2 ms server-side with RLS). End to end that is about 3 ms per RF7 call (8.0 → 5.1 ms p50). RF8 multiplies it by professionals × days: 47 → 20 ms.
2. **Why the RF7 gain is moderate, not dramatic.** The database query was already cheap thanks to `appointments_active_professional_start_idx` (index-justification §2): with 20,000 extra appointments of history the plan still reads one day of one professional. The remaining time is the gateway hop, JWT validation and HTTP, which a cache in the scheduler cannot remove. The hot-key throughput test (+18 %) is bound by those layers.
3. **Where the cache matters most.** RF8 and repeated RF7 calls (reception refreshing the same agenda) — and, above all, **load shedding**: a HIT never touches PostgreSQL, so the transactional engine is kept for bookings, where the race for the last slot is decided.
4. **A measurement that changed the system.** The first run of this benchmark showed RF7 MISS at ~30 ms; the plan revealed 20–40 ms of **JIT compilation** on every execution of a query that runs in 1 ms. JIT was disabled for the seven OLTP databases (`database/migrations/databases.sql`). Without that fix the cache would have hidden a production defect on every miss.
5. **Correctness does not depend on the cache.** I8 holds by construction (versioned keys bumped in the booking transaction) and is verified by tests that compare served slots with database rows; with Redis down the system answers correctly from PostgreSQL.

Reproduce: `docker compose up -d --wait && npm run bench:cache` (≈ 40 s; it restarts the scheduler container twice and only reads business data). Run it twice with at least 5 minutes in between to measure MISS again (TTL 300 s).
