# MediCitas — Seed Data

Seeds are Flyway versioned migrations (`V900+`) under each service's `seed/` folder. They load only when `SEED_DEMO_DATA=true` (the default). They run once, as the database owner. All identifiers are **deterministic**, so every database and the Keycloak realm reference the same entities.

## Identifier scheme

`T` = clinic number (1–3), `N` = sequence number.

| Entity | UUID pattern | Example (clinic 1) |
|---|---|---|
| Clinic (tenant) | `10000000-0000-4000-8000-00000000000T` | `10000000-0000-4000-8000-000000000001` |
| User | `20000000-0000-4000-8000-0000000T000N` | admin `…-000000010001` |
| Keycloak subject | `30000000-0000-4000-8000-0000000T000N` | admin `…-000000010001` |
| Platform admin subject | `30000000-0000-4000-8000-000000000000` | — |
| Specialty | `40000000-0000-4000-8000-0000000T000N` | — |
| Service | `41000000-0000-4000-8000-0000000T000N` | — |
| Professional | `42000000-0000-4000-8000-0000000T000N` | — |
| Patient | `50000000-0000-4000-8000-000T0000000N` (N = 1…120) | `…-000100000001` |
| Onboarding saga | `60000000-0000-4000-8000-00000000000T` | — |

User sequence `N`: 1 = clinic admin, 2–3 = receptionists, 11–13 = professionals 1–3.

## Clinics

| # | Name | Slug | Timezone |
|---|---|---|---|
| 1 | Clínica San José | `clinica-san-jose` | America/Costa_Rica |
| 2 | Centro Médico Heredia | `centro-medico-heredia` | America/Costa_Rica |
| 3 | Clínica del Istmo | `clinica-del-istmo` | America/Panama |

## Users (logins created in Keycloak by the realm import; passwords come from `.env`)

| Clinic | Admin | Receptionists | Professionals (specialty) |
|---|---|---|---|
| 1 | ana.mora@sanjose.medicitas.test | carlos.jimenez@…, laura.vargas@… | andres.rojas@… (General Medicine), sofia.castro@… (Pediatrics), javier.mendez@… (Dermatology) |
| 2 | mariela.quesada@heredia.medicitas.test | diego.araya@…, paola.chaves@… | gabriela.herrera@…, esteban.ulate@…, natalia.brenes@… |
| 3 | ricardo.pinzon@istmo.medicitas.test | yesenia.batista@…, luis.sanchez@… | omar.delgado@…, itzel.camargo@…, ruben.arosemena@… |

`.test` is a reserved TLD: no seeded address can reach a real mailbox.

## Catalog (identical per clinic)

| Service | Specialty | Duration | Offered by |
|---|---|---|---|
| General consultation | General Medicine | 30 min | professional 1 |
| Follow-up visit | General Medicine | 15 min | professional 1 |
| Pediatric consultation | Pediatrics | 30 min | professional 2 |
| Well-child check-up | Pediatrics | 45 min | professional 2 |
| Dermatology assessment | Dermatology | 45 min | professional 3 |
| Minor dermatologic procedure | Dermatology | 60 min | professional 3 |

## Weekly schedules and blocks

* Professional 1: Mon–Fri 08:00–12:00 and 13:00–17:00 (split shift, RF5).
* Professional 2: Mon/Wed/Fri 07:00–13:00; Tue/Thu 14:00–19:00.
* Professional 3: Tue–Fri 09:00–12:30 and 14:00–18:00; Sat 08:00–12:00.
* Calendar blocks: professional 3 vacation on local days +10 to +13; professional 1 leave on day −20 08:00–12:00; and a **conflict example**: a leave for professional 1 on day +5 08:00–10:00, created *after* bookings, so RF6 conflicts are listed.

## Patients and appointments

* 120 synthetic patients per clinic (deterministic names, Costa Rican/Panamanian-style IDs, synthetic contact data; patient 120 is inactive, patients without e-mail every 9th).
* Appointments from **45 days ago to 21 days ahead**, relative to the migration time. They are taken only from `compute_available_slots()` (the RF7 definition) and pass every production constraint and trigger.
  * Past: ~75% attended, ~10% no-show, ~10% cancelled (with reason and user), ~5% still booked (outcome pending).
  * Future: ~90% booked, ~10% cancelled. The density is lower beyond 7 days, so there are free slots for demos and tests.
  * Up to 3 reschedule chains per clinic (`booked → rescheduled` + successor one week later).
* Clinical notes for about one third of attended appointments, authored by the appointment's professional, each with its audit entry. There are also 10 patient-contact audit entries per clinic.

## Caveats

* Dates are relative to the moment the migration ran. On a long-lived volume the "future" appointments eventually become past. Recreate the volume (`docker compose down -v`) for a fresh demo.
* Seeds write replicas directly; they do not publish events (seed data is not announced through the outbox).
