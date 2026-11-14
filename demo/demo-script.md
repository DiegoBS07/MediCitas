# MediCitas — Reproducible demo script

The demo runs against the API with a command-line client (statement §5.7): [`demo/demo.mjs`](demo.mjs). Every step prints the request and the answer; nothing is typed by hand. A request collection for an HTTP client is also versioned: [`medicitas.http`](medicitas.http).

## Before the defense (≈ 3 minutes)

```bash
git clone <repo> && cd MediCitas
cp .env.example .env
docker compose down -v            # only if a previous run left data: back to the pristine seed
docker compose up -d --build --wait
npm ci                            # Node.js 24, only for the scripts and tests
npm run smoke                     # 10 read-only checks through the gateway
```

## Run

```bash
npm run demo -- --pause           # waits for Enter between steps; drop --pause to run straight through
npm run demo -- --pause --outage  # adds the Redis outage step at the end
```

Duration: about 1 minute without pauses. The script writes demo data (a clinic, patients, appointments, one outcome and one note); repeat runs work, and `docker compose down -v` resets everything.

## Steps, what to say, and where the evidence is

| # | Step (script output) | What it shows | Point to defend | Automated evidence |
|---|---|---|---|---|
| 1 | Stack up | `/health/ready` 200 | One command, no manual steps; services reach each other by name | `docs/operations/services.md` (clean start: 113 s) |
| 2 | Tokens from Keycloak, `GET /me` | `tenantId` comes from the token; the platform admin has none | Identity delegated (no login/JWT code of ours); tenant claim from a user attribute set at provisioning | `tests/acceptance/authorization.test.ts` |
| 3 | 401 / 403 / 200 | No token → 401; receptionist on the audit log → 403; platform admin on patients → 403 | Gateway checks the permission matrix; services re-validate | `authorization.test.ts` (47 routes × 5 principals) |
| 4 | Onboard a clinic | 201, tenant `active`, first admin | RF1 saga: tenant-management + Keycloak group/admin, compensation | `tests/acceptance/appointment-lifecycle.test.ts` (RF1) |
| 5 | Availability MISS → HIT | `X-Cache` header, version | Redis is a cache, never a source of truth; key = tenant + professional + service + date + version | `availability-cache.test.ts`, `docs/data/cache-report.md` |
| 6 | Register patient, book | 201 + `Location`, duration from the service | RF9 saga: patient, catalog and slot in parallel; scheduler is the authority of time | `appointment-lifecycle.test.ts`, `contracts.test.ts` (three outcomes) |
| 7 | Query again | slot gone, new version, `MISS` | **Criterion 5 / I8**: the version is bumped inside the booking transaction, before the HTTP answer | `availability-cache.test.ts` "criterion 5" |
| 8 | Two receptionists race | one 201, one 409 `SLOT_TAKEN` | **Criterion 6 / I1**: GiST exclusion constraint on `tstzrange`, READ COMMITTED + retry on serialization/deadlock | `tests/concurrency/last-slot-race.test.ts` (5 rounds + 10-way race) |
| 9 | Reschedule, invalid transition | previous `rescheduled`, current `booked`, old slot free; cancel a rescheduled one → 409 | RF10 in one transaction (I7); RF13 state machine | `appointment-lifecycle.test.ts` |
| 10 | Cancel | reason and author recorded | RF11; slot freed at once (I7) | same |
| 11 | Outcome, note, audit | past appointment → attended; the professional writes the note; the receptionist is denied and the denial is in the audit log | RF12 (database clock), RF15 (author only), RF18/RF19; audit log append-only at engine level (I6) | `audit.test.ts` |
| 12 | Another clinic | 404, header ignored, `?tenantId=` → 400, empty history | **Criterion 4 / I5**: tenant only from the token, discriminator + RLS (module 2) | `tenant-isolation.test.ts`, `docs/data/multi-tenancy-comparison.md` |
| 13 | History, agenda, counts | RF16, RF20 clinic-wide and own, RF21 | Professionals forced to their own agenda | `appointment-lifecycle.test.ts` |
| 14 | (`--outage`) Redis down | `X-Cache: BYPASS`, correct data | Degrade to PostgreSQL, never fake a hit | `availability-cache.test.ts` |

## Showing the tests (criterion 7)

```bash
npm test     # unit → integration against the running stack; ≈ 2 min
```

Useful single files during questions:

```bash
npx vitest run --project integration tests/concurrency/last-slot-race.test.ts
npx vitest run --project integration tests/acceptance/tenant-isolation.test.ts
npx vitest run --project integration tests/acceptance/availability-cache.test.ts
```

## Showing the database evidence

```bash
npm run bench:tenancy      # RLS vs discriminator on the same queries + leak tests (rolled back)
npm run evidence:explain   # EXPLAIN ANALYZE of the services' exact SQL, seed and volume (rolled back)
npm run bench:cache        # availability before/after the cache (restarts the scheduler twice)
```

Engine-level checks a teacher may ask for, in `psql` (`docker compose exec postgres psql -U "$POSTGRES_USER" -d medicitas_scheduler`):

```sql
-- I1/I2 are constraints, not application checks
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'scheduling.appointments'::regclass AND contype = 'x';
-- RLS is forced and the policy is the tenant predicate
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('appointments', 'audit_log');
-- the audit log rejects modification even by its owner (trigger + no grants)
SET ROLE sch_owner;
DELETE FROM scheduling.audit_log WHERE id = (SELECT id FROM scheduling.audit_log LIMIT 1);   -- ERROR 42501
RESET ROLE;
```
