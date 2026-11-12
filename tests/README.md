# MediCitas — Tests

| Suite | Command | Needs the stack |
|---|---|:-:|
| Unit (pure logic of every package/service) | `npm run test:unit` | ✘ |
| Integration, contract, concurrency (real PostgreSQL, RabbitMQ, Redis, Keycloak) | `npm run test:integration` | ✔ |
| Everything | `npm test` | ✔ |
| Type checking (sources and tests) | `npm run typecheck` | ✘ |
| No explicit `any` | `npm run check:no-any` | ✘ |

Prerequisites: Node.js 24, `npm ci`, `cp .env.example .env`, `docker compose up -d --build`.
Integration tests read `.env`, connect to `127.0.0.1`, create their own isolated data (unique queue names `test.<id>`, rolled-back transactions) and clean up after themselves. They never consume the queues of running services.

## Layout

* `shared-plane/*/tests` — unit tests of the shared libraries.
* `tests/integration/**` — tests against the real stack.
* `tests/contract/**` — consistency between code and data/broker contracts (e.g. the permission matrix).
* `tests/concurrency/**` — race tests (Stage 6).
* `tests/support/**` — helpers (environment, pools, broker, Keycloak).

## Known local issue: paths containing `#`

Vite/Vitest treat `#` as a URL fragment, so the tests cannot run from a directory such as `…/proyecto#1/MediCitas`. Evaluators cloning to a normal path are unaffected. Locally, either rename the parent folder, or run the tests through a junction without `#`:

```powershell
cmd /c mklink /J C:\medicitas "C:\path\to\proyecto#1\MediCitas"
cd C:\medicitas
$env:NODE_OPTIONS = "--preserve-symlinks --preserve-symlinks-main"
npm test
```

`vitest.config.ts` sets `resolve.preserveSymlinks` and resolves aliases from the working directory to support this.
