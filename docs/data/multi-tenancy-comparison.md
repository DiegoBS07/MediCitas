# Module 2 — RLS as a second strategy, compared with the discriminator column

Statement §9.2 (module 2): implement RLS in parallel with the chosen multi-tenancy strategy and compare both on the same queries, with isolation tests and measurements. The decision itself is in the README (§4).

## 1. The two strategies as implemented

| | Strategy 1 — discriminator column (chosen primary) | Strategy 2 — Row-Level Security (in parallel) |
|---|---|---|
| Mechanism | `tenant_id NOT NULL` in every tenant-scoped table; every query filters `WHERE tenant_id = $1`; composite FKs `(tenant_id, x_id)` and every UNIQUE include `tenant_id` | `ENABLE` + `FORCE ROW LEVEL SECURITY`; policy `tenant_isolation USING/WITH CHECK (tenant_id = app.current_tenant_id())`; context set per transaction with `set_config('app.tenant_id', $1, true)` |
| Who enforces it | The application (every query author) | The engine, for every statement of a runtime role, including ad-hoc and buggy queries |
| Failure mode | A forgotten predicate leaks every tenant | A forgotten predicate returns only the current tenant; an absent context returns nothing; a malformed context aborts |
| Roles | — | Runtime roles never own tables and have no `BYPASSRLS`; only the test-only `*_bench_norls` role bypasses RLS (never used by services) |

Both are active in production (mode C). The comparison isolates each one on the **same queries** and the **same data**.

## 2. Protocol

* Tool: [`metrics/bench-multitenancy.mjs`](../../metrics/bench-multitenancy.mjs) (`npm run bench:tenancy`). Raw evidence: [`metrics/results/multitenancy-benchmark.json`](../../metrics/results/multitenancy-benchmark.json).
* PostgreSQL 18.6, `jit = off` (see index-justification §1b), 100 measured runs per query and mode after 5 warm-up runs; the metric is the **server-side** `Execution Time` and `Planning Time` of `EXPLAIN (ANALYZE, BUFFERS)`, so network and driver noise are excluded.
* Modes:

| Mode | Role | Query text |
|---|---|---|
| **A** discriminator only | `sch_bench_norls` (`BYPASSRLS`) | `WHERE … tenant_id = $1` |
| **B** RLS only | runtime actor role (`sch_receptionist`, `sch_clinic_admin` for RF19) | **no** tenant predicate (a tautology that still binds `$1`) |
| **C** both — production | runtime actor role | `WHERE … tenant_id = $1`, plus the policy |

* Queries: RF7 (availability, the most frequent), RF16 (patient history), RF20 (clinic day agenda), RF21 (counts by status over a year), RF19 (audit log by patient). Clinic 1, its professional 1 and service 1, next Monday.
* Datasets: **seed** (2,678 appointments, 939 in clinic 1; 789 audit rows) and **seed + synthetic history** (62,725 appointments, 20,954 in clinic 1; 60,789 audit rows), loaded and measured inside one transaction that is rolled back.

## 3. Results

### 3.1 Seed

| Query | Mode A exec / plan (ms) | Mode B exec / plan (ms) | Mode C exec / plan (ms) | Rows | Index used (all modes) |
|---|---|---|---|--:|---|
| RF7 | 0.257 / 1.171 | 0.256 / 1.743 | 0.247 / 1.763 | 10 | `appointments_active_professional_start_idx`, `calendar_blocks_active_period_idx`, `weekly_schedule_blocks_no_overlap` |
| RF16 | 0.025 / 0.056 | 0.027 / 0.082 | 0.030 / 0.081 | 13 | `appointments_patient_history_idx` |
| RF20 | 0.148 / 0.231 | 0.209 / 0.291 | 0.151 / 0.255 | 41 | `appointments_tenant_start_idx` |
| RF21 | 0.442 / 0.098 | 1.093 / 0.121 | 0.483 / 0.115 | 5 | sequential scan (small table) |
| RF19 | 0.032 / 0.053 | 0.035 / 0.078 | 0.037 / 0.073 | 10 | `audit_log_tenant_patient_idx` |

### 3.2 Seed + synthetic history (×23 appointments, ×77 audit rows)

| Query | Mode A exec / plan (ms) | Mode B exec / plan (ms) | Mode C exec / plan (ms) | Rows | Index used (all modes) |
|---|---|---|---|--:|---|
| RF7 | 0.221 / 1.161 | 0.242 / 1.697 | 0.267 / 1.726 | 10 | same three indexes |
| RF16 | 0.036 / 0.065 | 0.031 / 0.081 | 0.034 / 0.079 | 20 | `appointments_patient_history_idx` |
| RF20 | 0.141 / 0.230 | 0.205 / 0.300 | 0.155 / 0.272 | 41 | `appointments_tenant_start_idx` |
| RF21 | 2.374 / 0.132 | 2.183 / 0.128 | 2.660 / 0.139 | 5 | `appointments_tenant_start_idx` (≈ 6,900 rows aggregated) |
| RF19 | 0.023 / 0.045 | 0.036 / 0.085 | 0.037 / 0.080 | 14 | `audit_log_tenant_patient_idx` |

p95 values and shared-buffer counts are in the JSON evidence; p95 stays within 1.4× the median for every row.

### 3.3 Isolation (leak tests, same "buggy" query without any tenant predicate)

| Scenario | Seed | With history |
|---|---|---|
| Strategy 1 alone (`bench_norls`), predicate forgotten | **2,678 rows from 20 tenants — leak** | **62,725 rows from 20 tenants — leak** |
| Strategy 2 (runtime role, context = clinic 1), predicate forgotten | 939 rows, 1 tenant | 20,954 rows, 1 tenant |
| Strategy 2, no tenant context | 0 rows | 0 rows |
| Strategy 2, malformed context | error `22P02` (transaction aborted) | error `22P02` |
| Strategy 2, explicit `WHERE tenant_id = ANY(<other clinics>)` | 0 rows | 0 rows |

The API-level leak attempts (foreign ids, manipulated query/body/header parameters, foreign cursors, foreign mutations) are in `tests/acceptance/tenant-isolation.test.ts`; the engine-level checks there also prove the `WITH CHECK` side (an insert for another tenant fails with `42501 … row-level security`).

## 4. Analysis

1. **Same plans, same indexes.** For every measured query the three modes choose the same access path. RLS does not change *what* is read: shared buffers are identical across modes (JSON). This holds because every index leads with `tenant_id` and the policy predicate (`tenant_id = app.current_tenant_id()`) uses only leakproof operators, so it becomes an index condition.
2. **Execution overhead is within noise.** Differences between modes are hundredths of a millisecond (RF16, RF19) or about 0.05 ms (RF20, RF7) — the cost of evaluating `app.current_tenant_id()` per row inside the index condition. RF21 with history: 2.37 ms (A) vs 2.66 ms (C), +12 % on the heaviest aggregate. Mode B is slower than A on RF21 with the seed (1.09 vs 0.44 ms) because without the explicit predicate the planner's estimate is less precise; production (C) keeps the explicit predicate, which is why the protocol recommends **both**.
3. **The real cost of RLS is planning time**: about +0.5 ms on RF7 (1.17 → 1.73–1.76 ms) and +0.02–0.04 ms on the simple queries, from expanding the policy into every relation of the query. For RF7 this is larger than its execution time, and it is one reason why the availability cache pays off (cache-report.md).
4. **RLS constrains index design.** Non-leakproof functions (`lower()`, `&&`, `lower(range)`) cannot be index conditions under RLS. Found twice and fixed by stored generated columns: `appointments.starts_at/ends_at` and `patients.search_last_name/search_first_name` (index-justification §1c). Mode A would have used the expression indexes; designing indexes for mode A would have looked fine in tests without RLS and degraded in production.
5. **Isolation is where the strategies differ.** With the discriminator alone, one forgotten predicate exposes all 20 tenants of the database (§3.3). With RLS the same bug is contained to the caller's tenant, and an absent or malformed context returns nothing or aborts.

## 5. Conclusion

RLS costs about 0.5 ms of planning on the most complex query and less than 0.1 ms of execution, while turning a class of bugs (a forgotten `tenant_id` filter, a raw query in a migration-like path, a consumer that forgot to set the tenant) from a cross-tenant leak into an empty or tenant-scoped result. The production configuration keeps **both**: the discriminator for precise plans, composite foreign keys and unique constraints, and RLS as the engine-enforced second barrier. Schema-per-tenant was rejected for its onboarding DDL and N-fold migrations.

Reproduce: `docker compose up -d --wait && npm run bench:tenancy` (≈ 20 s; nothing is persisted).
