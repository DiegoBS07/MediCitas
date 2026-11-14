# MediCitas — Index Justification

> Rule: every index serves a named query, with a predicate and an expected cardinality, and is backed by an `EXPLAIN (ANALYZE, BUFFERS)` plan of the query the service actually runs. Constraint-backing indexes (PK, UNIQUE, EXCLUDE) are justified by the constraint itself.
> Evidence is produced on the production path: actor role via `SET LOCAL ROLE`, `app.tenant_id` set, i.e. **discriminator + RLS** (mode C of the multi-tenancy comparison), with the seed **and** with synthetic history (~20,000 appointments, ~20,000 audit rows and ~20,000 patients per seeded clinic, rolled back).
>
> Evidence files (`metrics/results/`):
> * [`explain-app-queries.txt`](../../metrics/results/explain-app-queries.txt) — the **exact SQL** of the repositories, seed and volume. Tool: `metrics/explain-app-queries.mjs` (`npm run evidence:explain`).
> * [`explain-main-queries.txt`](../../metrics/results/explain-main-queries.txt), [`explain-rf7-volume.txt`](../../metrics/results/explain-rf7-volume.txt) — RF7/RF16/RF19/RF20/RF21 and the RF7 scaling experiment. Tools: `database/tools/explain-main-queries.sql`, `explain-rf7-volume.sql`.
> * [`multitenancy-benchmark.json`](../../metrics/results/multitenancy-benchmark.json) — the same queries timed under modes A/B/C (module 2, [`multi-tenancy-comparison.md`](multi-tenancy-comparison.md)).

## 1. Findings that shaped the indexes

### 1a. RLS and non-LEAKPROOF operators

RLS policies act as *security barriers*: a user predicate whose function is not `LEAKPROOF` is evaluated **after** the policy and cannot become an index condition.

| Operator / function | `proleakproof` |
|---|:-:|
| `&&` (`range_overlaps`), `lower(anyrange)`, `lower(text)`, `~~` (`LIKE`) | **false** |
| `=`, `<`, `>=` on `uuid`, `timestamptz`, `text`; `~>=~`, `~<~` (`text_pattern_ops`) | true |

Fix for appointments (scheduler `V4`/`V5`): stored generated columns `starts_at = lower(slot)` / `ends_at = upper(slot)`, btree indexes on them, and RF7 written with leakproof comparisons bounded to the local day. The GiST exclusion constraints on `slot` stay (a constraint check is not subject to RLS).

| Query | Before (`lower(slot)` / `&&`) | After (`starts_at`, leakproof) |
|---|---|---|
| RF7 availability (prof. 1, one Monday) | 132 active appointments materialized, 3,800 rows removed by the join filter, 1.90 ms | index range on the day, 7 rows read, **0.27 ms** |
| RF20 clinic agenda (one day) | 801 rows read, 788 removed; 0.35 ms | 13 rows read, 0 removed; **0.11 ms** |
| RF21 counts (30 days) | 801 read, 431 removed; 0.41 ms | 374 read; **0.19 ms** |

### 1b. JIT compilation on RF7

A first measurement showed RF7 at **20–40 ms** of server execution, all of it attributed to the first plan node. The cause was **JIT compilation**: the planner's cost estimate for RF7 (generate_series candidates joined with two anti-joins) exceeds `jit_above_cost` (100,000), so PostgreSQL compiled the expressions on **every** execution. With `jit = off` the same plan executes in **0.25–1.0 ms**.

| RF7 (inlined `compute_available_slots`, production path) | Execution |
|---|---|
| `jit = on` (PostgreSQL default) | 39.29 ms (19.2 ms in the first node = JIT) |
| `jit = off` | **1.08 ms** (`explain-main-queries.txt`), 0.25 ms median over 100 runs (module 2 benchmark) |

Fix: `ALTER DATABASE … SET jit = off` for the seven OLTP databases in `database/migrations/databases.sql` (idempotent bootstrap, applied on every `docker compose up`, so existing volumes get it too). JIT pays off for long analytical scans, never for millisecond transactional queries.

### 1c. Patient search under RLS

`GET /patients?q=` filtered and ordered by `lower(last_name)`. `lower()` is not leakproof, so the expression index `patients_last_name_search_idx (tenant_id, lower(last_name) text_pattern_ops, id)` was **never used** in production: with 20,000 patients per clinic the search read every row of the tenant and the list sorted all of them.

Fix (user-management `V5__patient_search_columns.sql`): stored generated columns `search_last_name = lower(last_name)`, `search_first_name = lower(first_name)`; `LIKE 'x%'` on a plain column is served by `text_pattern_ops` through the leakproof `~>=~`/`~<~`; ordering and keyset use a default-collation index, so the alphabetical order users see is unchanged.

| `medicitas_user`, 20,120 patients in clinic 1 | Before | After |
|---|---|---|
| Patient list, first page (`ORDER BY …, id LIMIT 21`) | Bitmap scan of the whole tenant + sort, **23.40 ms** | Index Scan `patients_listing_idx`, **0.055 ms** |
| Prefix search `q=mor` (≈ 10 % of the synthetic surnames match) | whole tenant read, 18,114 rows removed by filter, **13.84 ms** | ordered `patients_listing_idx` scan stopping at 21 matches, **4.36 ms**; with the seed the planner uses `patients_first_name_search_idx` (0.11 ms) |

Same pattern, same reason as 1a: under RLS, indexes must target plain columns and leakproof operators.

## 2. Index catalog — `medicitas_scheduler`

Dataset: seed (2,678 appointments, 789 audit rows) and seed + synthetic history (62,725 appointments, 60,789 audit rows).

| Index | Serves | Predicate in the query | Expected cardinality | Evidence (final) |
|---|---|---|---|---|
| `appointments_active_professional_start_idx` btree `(tenant_id, professional_id, starts_at) INCLUDE (ends_at) WHERE status IN ('held','booked')` | **RF7** (inside `compute_available_slots`), RF8 per professional/date, I1 checks | `tenant_id = ctx AND professional_id = $p AND status IN (...) AND starts_at` within the local day | ≤ ~32 rows (one day of one professional) regardless of history | Index Only Scan in RF7 with the seed and with 20,954 appointments in the clinic; with **8,140** active rows for one professional the scan still reads **8** rows (0.09 ms, `explain-rf7-volume.txt`) |
| `appointments_tenant_start_idx` btree `(tenant_id, starts_at) INCLUDE (status, professional_id)` | **RF20** clinic day agenda, **RF21** counts | `tenant_id = ctx AND starts_at >= $from AND starts_at < $to` | Agenda: tens per day; counts: thousands per year | Index Scan (RF20, 41 rows, 0.15 ms); Bitmap Index Scan with history (RF21 over 365 days, ≈ 6,900 rows, 2.4–2.7 ms). With the seed the planner prefers a sequential scan for RF21 (whole table < 3,000 rows) |
| `appointments_patient_history_idx` btree `(tenant_id, patient_id, starts_at DESC)` | **RF16** patient history, newest first | `tenant_id = ctx AND patient_id = $p ORDER BY starts_at DESC LIMIT n` | ~10–50 per patient | Index Scan, no sort node, 0.03 ms (seed and history) |
| `appointments_held_expiry_idx` btree `(hold_expires_at) WHERE status = 'held'` | Hold-expiry sweeper discovery (every 5 s, worker role, cross-tenant) | `status = 'held' AND hold_expires_at <= now() ORDER BY hold_expires_at LIMIT 100` | ≈ 0 (holds live seconds) | Index Scan of the partial index, 0.013 ms with 62,725 appointments (`explain-app-queries.txt`) |
| `appointments_no_professional_overlap` GiST `(tenant_id, professional_id, slot) WHERE active` | **Constraint I1** | — | — | `EXCLUDE` constraint; direct overlapping insert → `23P01` (`tests/acceptance/invariants.test.ts`) |
| `appointments_no_patient_overlap` GiST `(tenant_id, patient_id, slot) WHERE active` | **Constraint I2** | — | — | `EXCLUDE` constraint; `23P01` (same test) |
| `appointments_rescheduled_from_unique` | Constraint: one successor per rescheduled appointment (RF10) | — | — | Constraint |
| `appointments_tenant_id_unique` `(tenant_id, id)` | Composite FK target (`clinical_notes`, reschedule chain); tenant-scoped id lookups | `tenant_id = ctx AND id = $id` | 1 | Constraint |
| `calendar_blocks_active_period_idx` GiST `(tenant_id, professional_id, period) WHERE active` | I3 check in the booking trigger; RF7 block subtraction; RF6 conflicts | equality columns + `period && slot` | a few per professional | **Index Only Scan** in RF7 (the equality columns are index conditions; `&&` is rechecked) — kept |
| `weekly_schedule_blocks_no_overlap` GiST (RF5 `EXCLUDE`) | Constraint RF5 (no overlapping blocks per weekday); also serves the RF7 lookup of a professional's blocks | `tenant_id = ctx AND professional_id = $p` | ≤ 14 rows | Bitmap Index Scan in RF7, 0.03 ms |
| `audit_log_tenant_patient_idx` `(tenant_id, patient_id, occurred_at DESC)` | **RF19** filter by patient | RLS `tenant_id = ctx` + `patient_id = $2 ORDER BY occurred_at DESC` | tens per patient | Index Scan, 0.035 ms with 20,295 audit rows in the clinic |
| `audit_log_tenant_actor_idx` `(tenant_id, actor_subject, occurred_at DESC)` | **RF19** filter by user | `actor_subject = $1` | hundreds per user | Index Scan with history (0.11 ms); sequential scan with the seed (295 rows — correct) |
| `audit_log_tenant_time_idx` `(tenant_id, occurred_at DESC, id)` | **RF19** date range only, keyset pagination | `occurred_at >= $3 ORDER BY occurred_at DESC, id DESC` | grows linearly | Index Scan with history (0.07 ms); sequential scan with the seed |
| `audit_log_source_message_unique` | Constraint: one audit row per consumed event (last line of defence after the inbox) | — | — | Constraint |
| `availability_versions` PK `(tenant_id, professional_id, local_date)` | Upsert target of the version bump; cache version lookup | full PK equality | 1 | Constraint-backed. At 98 rows the planner reads the table sequentially for the lookup; the PK is required by `INSERT … ON CONFLICT` regardless |
| `catalog_professional_services_service_idx` `(tenant_id, service_id)` | **RF8**: professionals offering a service | `service_id = $1` | a few | At ~100 rows the planner seq-scans; kept for RF8's access path as the catalog grows (writes are rare: association changes only) |

The RF7 queries that the services run (`availabilityContext` + `computeSlots`) execute in 0.09–0.37 ms with history (`explain-app-queries.txt`). Small replica and settings tables (`tenants`, `catalog_*`, `scheduling_settings`) are read sequentially at this size, which is the correct plan for tables of tens of rows.

## 3. Other databases

| Database | Index | Serves | Evidence |
|---|---|---|---|
| user | `patients_listing_idx` `(tenant_id, search_last_name, id)` | `GET /patients` ordering + keyset; also the ordered search | Index Scan, 0.055 ms with 20,120 patients (§1c) |
| user | `patients_last_name_search_idx`, `patients_first_name_search_idx` `(tenant_id, search_*_name text_pattern_ops)` | `GET /patients?q=` prefix | Bitmap Index Scan with the seed (§1c) |
| user | `patients_identification_search_idx` `(tenant_id, identification_number text_pattern_ops)` | `GET /patients?q=` by document number | Bitmap Index Scan (seed) |
| user | `patients_identification_unique` | Constraint `PATIENT_IDENTIFICATION_TAKEN` | Constraint |
| user | `users_email_unique` (lower(email)) partial | Constraint `EMAIL_TAKEN` (case-insensitive, realm-wide) | Constraint (a uniqueness check is not subject to RLS) |
| user | `users_tenant_listing_idx` `(tenant_id, last_name, first_name, id)` | `GET /users` keyset pagination | Staff lists are tens of rows per clinic; the staff search `GET /users?q=` still uses `lower()` and reads the tenant's users — accepted, a clinic has tens of staff, not thousands |
| catalog | `specialties_name_unique`, `services_name_unique` | Constraints (case-insensitive names) | Constraint |
| catalog | `professional_services_service_idx` | `GET /professionals?serviceId=` | small table |
| all | `outbox_messages_pending_idx` partial | Relay claim (`FOR UPDATE SKIP LOCKED`) | partial index of the pending set |
| all | `inbox_messages_received_at_idx`, `idempotency_records_expires_at_idx` | Retention clean-up | — |
| orchestrators | `saga_instances_open_deadline_idx` partial | Saga sweepers (deadlines, re-sends) | partial index of open sagas |
| user-orchestrator | `saga_instances_one_open_per_user` unique partial | Constraint: one running saga per user | Constraint |

## 4. Reproduce

```bash
docker compose up -d --wait
npm run evidence:explain     # exact application SQL, seed + volume (rolled back)
npm run bench:tenancy        # module 2 timings (rolled back)
# SQL tools (psql inside the postgres container, as superuser; they SET LOCAL ROLE themselves):
docker compose exec -T -e PGOPTIONS='-c search_path=scheduling,app,public' postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d medicitas_scheduler -f -' < database/tools/explain-main-queries.sql
```
