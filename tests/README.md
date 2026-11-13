# MediCitas — Tests

| Suite | Command | Runs against | Tests |
|---|---|---|--:|
| Unit (pure logic of every package and service) | `npm run test:unit` | nothing (no I/O, no Docker) | 93 |
| Integration | `npm run test:integration` | the **running Compose stack**: the API through the gateway, plus PostgreSQL and RabbitMQ directly for transaction and messaging reliability | 98 |
| **Everything** (the documented command) | **`npm test`** | unit, then integration | 191 |
| Type checking (sources and tests) | `npm run typecheck` | — | — |
| No explicit `any` | `npm run check:no-any` | — | — |

Prerequisites: Node.js 24, `npm ci`, `cp .env.example .env`, `docker compose up -d --build --wait`. No data has to be prepared by hand, and no test reads the `docs/` folder.

## How the integration suite works

* The Vitest global setup (`tests/acceptance/global-setup.ts`) starts the stack if a service container is not healthy, then **onboards a fresh clinic for the run** through the public API (RF1) and creates its staff (RF2: admin, two receptionists) and catalog (RF3: a specialty and a 30-minute service). Each test file creates its own professionals (RF2 + RF4 + RF5), so files never compete for slots and the demo clinics are never modified (they are only *attacked* by the isolation tests and used read-only by the authorization matrix).
* The resilience tests stop and restart Redis, RabbitMQ, Keycloak and the catalog container on purpose, always restoring them in a `finally` block.
* Files run one after another (`fileParallelism: false`).

| Folder | Content |
|---|---|
| `tests/acceptance/` | Appointment cycle (RF1–RF21), authorization (47 routes × 5 principals), tenant isolation (I5), availability cache (I7/I8), audit (RF18/RF19/I6), invariants I1–I4 (API and engine), dependency failure and restart |
| `tests/contract/` | API and messaging contracts on the running system: error model, idempotency, pagination, the three booking outcomes, the message envelope |
| `tests/concurrency/` | The race for the last slot: two receptionists, 5 rounds, a 10-way race, patient and reschedule races |
| `tests/integration/shared-plane/` | Transactions (actor role, RLS context, isolation level, deadlock/serialization retries) and messaging reliability (retries with back-off, dead-letter, de-duplication) |
| `tests/support/`, `tests/acceptance/support/` | Helpers (environment, pools, broker, API client, fixtures) |

The test report (which test covers which RF and invariant) is in the README, section 6.

## Test data and clean-up

* Every run uses unique identifiers (clinic slug `acc-<run>`, e-mails `@<run>.acc.medicitas.test`, patients `ACC-…`, queues `test.<id>`).
* Appointments and audit rows are append-only by design: they stay in the local database under the run's own clinic. `docker compose down -v && docker compose up -d --build --wait` resets everything to the seed.
* The run's Keycloak users and its clinic group are deleted at the end. Passwords of test users are random per run and never printed; tokens are never logged.

### Fixtures that go beyond the public API (and why)

| Fixture | Why | Where |
|---|---|---|
| Permanent password set through the Keycloak Admin REST API (provisioner service account) | RF2 creates users with a *temporary* password; the test stands in for the user completing the first-login change | `tests/acceptance/support/fixture.ts` |
| Booked appointment inserted in the past with the scheduler **owner** role | RF12/RF15 need an appointment whose start has passed; the API rightly refuses past bookings and early outcomes. Every constraint and trigger still validates the row | `tests/acceptance/support/clock.ts` |
| Direct inserts that must fail | Prove I1–I4 are enforced by PostgreSQL even if a service were bypassed | `tests/acceptance/invariants.test.ts` |
| Read-only evidence queries (`sch_readonly`, RLS applies) | Compare what the API answered with what the database holds (race, I1/I2, I8) | `tests/acceptance/support/evidence.ts` |

## Running a single file

```bash
npx vitest run --project integration tests/concurrency/last-slot-race.test.ts
npx vitest run --project unit shared-plane/kernel/tests/errors.test.ts
```

Add `--reporter=verbose` to list every test name, or `-t "<part of a name>"` to run one test.

## Known local issues

* **Paths containing `#`.** Vite/Vitest treat `#` as a URL fragment, so the tests cannot run from a directory such as `…/proyecto#1/MediCitas`. Evaluators cloning to a normal path are unaffected. Locally, run the tests through a junction without `#`:

  ```powershell
  cmd /c mklink /J C:\medicitas "C:\path\to\proyecto#1\MediCitas"
  cd C:\medicitas
  $env:NODE_OPTIONS = "--preserve-symlinks --preserve-symlinks-main"
  npm test
  ```

* **PowerShell execution policy.** If `npm` reports that running scripts is disabled, run once `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`, or call `npm.cmd` / `npx.cmd`.
* **Keycloak brute-force detection** rejects one of two concurrent password grants of the same user (`invalid_grant`); the test token helper shares one in-flight request per user.
