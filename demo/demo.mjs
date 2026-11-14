#!/usr/bin/env node
// =============================================================================
// MediCitas — reproducible defense demo, against the running Compose stack, through the API gateway.
//
//   docker compose up -d --build --wait
//   npm run demo                 # runs every step and prints each request and its answer
//   npm run demo -- --pause      # waits for Enter between steps (live defense)
//   npm run demo -- --outage     # adds the Redis outage step (stops and restarts the redis container)
//
// Uses the seeded clinics and users; tokens come from Keycloak (password grant of
// the local-evaluation client medicitas-cli). It WRITES demo data (a new clinic, a patient, appointments,
// one outcome and one clinical note): run `docker compose down -v` to return to the pristine seed.
// Tokens and passwords are never printed.
// =============================================================================
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

if (existsSync('.env')) process.loadEnvFile('.env');
const PAUSE = process.argv.includes('--pause');
const OUTAGE = process.argv.includes('--outage');
const GATEWAY = `http://localhost:${process.env.GATEWAY_HOST_PORT ?? '8000'}`;
const KEYCLOAK = process.env.KEYCLOAK_PUBLIC_URL ?? 'http://localhost:8080';
const TZ = 'America/Costa_Rica';
const PROFESSIONAL = '42000000-0000-4000-8000-000000010001'; // Dr. Andrés Rojas, clinic 1
const SERVICE = '41000000-0000-4000-8000-000000010001'; // general consultation, 30 min
const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color('1');
const dim = color('2');
const green = color('32');
const red = color('31');
const cyan = color('36');

const rl = PAUSE ? createInterface({ input: process.stdin, output: process.stdout }) : null;
let stepNumber = 0;
async function step(title, subtitle) {
  stepNumber += 1;
  if (rl !== null && stepNumber > 1) await rl.question(dim('\n[Enter] next step '));
  console.log(`\n${bold(cyan(`▶ ${stepNumber}. ${title}`))}${subtitle === undefined ? '' : dim(`  — ${subtitle}`)}`);
}

async function token(username, password) {
  const response = await fetch(`${KEYCLOAK}/realms/medicitas/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'medicitas-cli', username, password }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Keycloak refused ${username} (HTTP ${response.status}); is the stack up and .env in place?`);
  return body.access_token;
}

/** One API call, printed as "METHOD path → status" plus selected fields of the answer. */
async function call(method, path, { as, body, headers = {}, show = () => '', label } = {}) {
  const requestHeaders = { ...headers };
  if (as !== undefined) requestHeaders.Authorization = `Bearer ${as}`;
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  const response = await fetch(`${GATEWAY}${path}`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const json = text === '' ? null : JSON.parse(text);
  const ok = response.status < 400;
  const detail = ok ? show(json, response) : `${json?.code ?? ''}${json?.detail === undefined ? '' : ` — ${json.detail}`}`;
  console.log(`  ${label === undefined ? '' : dim(`${label}: `)}${method} ${path.length > 95 ? `${path.slice(0, 92)}…` : path} → ${(ok ? green : red)(String(response.status))}${detail === '' ? '' : `  ${detail}`}`);
  return { status: response.status, body: json, headers: response.headers };
}

const localDate = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + days * 86_400_000));
const localTime = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const slotsOf = (result) => result.body.data.slots.map((slot) => slot.startAt);
const showSlots = (json, response) => `X-Cache: ${response.headers.get('x-cache')} · ${json.data.slots.length} free slots · version ${json.data.version}`;
const ik = () => ({ 'Idempotency-Key': `demo-${randomUUID()}` });

// ---------------------------------------------------------------------------------------------------------
await step('The stack is up', 'one command: docker compose up --build');
await call('GET', '/health/ready', { show: (json) => JSON.stringify(json) });

await step('Identity is delegated to Keycloak; the clinic comes from the token', 'RF17');
const demoPassword = process.env.MEDICITAS_DEMO_USER_PASSWORD ?? '';
const [platform, admin, receptionist, receptionist2, professional, foreign] = await Promise.all([
  token('platform.admin@medicitas.test', process.env.MEDICITAS_PLATFORM_ADMIN_PASSWORD ?? ''),
  token('ana.mora@sanjose.medicitas.test', demoPassword),
  token('carlos.jimenez@sanjose.medicitas.test', demoPassword),
  token('laura.vargas@sanjose.medicitas.test', demoPassword),
  token('andres.rojas@sanjose.medicitas.test', demoPassword),
  token('diego.araya@heredia.medicitas.test', demoPassword),
]);
console.log(dim('  6 tokens obtained from Keycloak (never printed): platform admin, clinic-1 admin, 2 receptionists, a professional, a clinic-2 receptionist'));
await call('GET', '/api/v1/me', { as: receptionist, label: 'receptionist', show: (json) => `tenantId=${json.data.tenantId} roles=${json.data.roles}` });
await call('GET', '/api/v1/me', { as: platform, label: 'platform admin', show: (json) => `tenantId=${json.data.tenantId} (belongs to no clinic)` });

await step('401 without a token, 403 with the wrong role', 'acceptance criterion 3');
await call('GET', '/api/v1/patients');
await call('GET', '/api/v1/audit-log', { as: receptionist, label: 'receptionist' });
await call('GET', '/api/v1/patients', { as: platform, label: 'platform admin' });
await call('GET', '/api/v1/patients?limit=2', { as: receptionist, label: 'receptionist', show: (json) => `${json.data.length} patients (no contact data in lists)` });

await step('Onboard a clinic with its first administrator', 'RF1 saga: tenant-management + Keycloak, compensated on failure');
const slug = `demo-${randomUUID().slice(0, 6)}`;
await call('POST', '/api/v1/tenants', {
  as: platform,
  headers: ik(),
  body: { name: `Demo Clinic ${slug}`, slug, timezone: 'America/Costa_Rica', firstAdmin: { email: `admin@${slug}.medicitas.test`, firstName: 'Demo', lastName: 'Admin', temporaryPassword: `Tmp-${randomUUID()}` } },
  show: (json) => `tenant ${json.data.tenantId} status=${json.data.status}, first admin ${json.data.firstAdmin.email}`,
});

await step('Availability of a professional on a date — cache miss, then hit', 'RF7, Redis');
// The first weekday (Mon–Fri, the seeded professional's working days) from +9 days on, where the seed
// leaves free slots. No probe request, so the first query below is a genuine cache MISS.
let date = localDate(9);
for (let offset = 9; offset < 20; offset += 1) {
  date = localDate(offset);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday >= 1 && weekday <= 5) break;
}
console.log(dim(`  Dr. Andrés Rojas, general consultation (30 min), ${date}`));
let view = await call('GET', `/api/v1/availability?professionalId=${PROFESSIONAL}&serviceId=${SERVICE}&date=${date}`, { as: receptionist, show: showSlots });
view = await call('GET', `/api/v1/availability?professionalId=${PROFESSIONAL}&serviceId=${SERVICE}&date=${date}`, { as: receptionist, show: showSlots });
const slots = slotsOf(view);
await call('GET', `/api/v1/availability/search?serviceId=${SERVICE}&from=${date}&to=${localDate(13)}`, {
  as: receptionist,
  label: 'RF8',
  show: (json) => `${json.data.professionals.length} professionals with free slots`,
});

await step('Register a patient and book one of the returned slots', 'RF14 + RF9 saga (patient, catalog, scheduler in parallel)');
const patient = await call('POST', '/api/v1/patients', {
  as: receptionist,
  body: {
    identificationType: 'passport',
    identificationNumber: `DEMO-${randomUUID().slice(0, 8)}`,
    firstName: 'Lucía',
    lastName: 'Demo',
    birthDate: '1988-07-14',
    contact: { email: 'lucia.demo@example.test', phone: '+50688881234' },
  },
  show: (json) => `patientId=${json.data.patientId}`,
});
const patientId = patient.body.data.patientId;
const booked = await call('POST', '/api/v1/appointments', {
  as: receptionist,
  headers: ik(),
  body: { patient: { id: patientId }, professionalId: PROFESSIONAL, serviceId: SERVICE, startAt: slots[0] },
  show: (json, response) => `${json.data.status} ${localTime(json.data.startAt)}–${localTime(json.data.endAt)} (${json.data.durationMinutes} min from the service, I4) · Location ${response.headers.get('location')}`,
});
const appointmentId = booked.body.data.appointmentId;

await step('Query again: the slot is already taken, without waiting for any TTL', 'acceptance criterion 5, I8');
const after = await call('GET', `/api/v1/availability?professionalId=${PROFESSIONAL}&serviceId=${SERVICE}&date=${date}`, { as: receptionist, show: showSlots });
console.log(`  ${localTime(slots[0])} still offered? ${slotsOf(after).includes(slots[0]) ? red('YES') : green('no')} — the booking bumped the version inside its own transaction`);

await step('Two receptionists race for the same slot', 'acceptance criterion 6: exactly one winner');
const target = slots[slots.length - 1];
const [p1, p2] = await Promise.all(
  ['Race One', 'Race Two'].map(async (name, index) =>
    (await fetch(`${GATEWAY}/api/v1/patients`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${index === 0 ? receptionist : receptionist2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ identificationType: 'passport', identificationNumber: `RACE-${randomUUID().slice(0, 8)}`, firstName: name.split(' ')[0], lastName: name.split(' ')[1], birthDate: '1990-01-01' }),
    }).then((response) => response.json())).data.patientId,
  ),
);
const race = await Promise.all([
  call('POST', '/api/v1/appointments', { as: receptionist, headers: ik(), label: 'Carlos', body: { patient: { id: p1 }, professionalId: PROFESSIONAL, serviceId: SERVICE, startAt: target }, show: (json) => json.data.status }),
  call('POST', '/api/v1/appointments', { as: receptionist2, headers: ik(), label: 'Laura ', body: { patient: { id: p2 }, professionalId: PROFESSIONAL, serviceId: SERVICE, startAt: target }, show: (json) => json.data.status }),
]);
console.log(`  winners: ${race.filter((result) => result.status === 201).length} · losers with 409 SLOT_TAKEN: ${race.filter((result) => result.body?.code === 'SLOT_TAKEN').length}`);

await step('Reschedule atomically, then try an invalid transition', 'RF10 (one transaction), RF13, I7');
const moved = await call('POST', `/api/v1/appointments/${appointmentId}/reschedule`, {
  as: receptionist,
  body: { startAt: slots[Math.min(4, slots.length - 2)] },
  show: (json) => `previous → ${json.data.previous.status}, current → ${json.data.current.status} at ${localTime(json.data.current.startAt)}`,
});
const currentId = moved.body.data.current.appointmentId;
await call('GET', `/api/v1/availability?professionalId=${PROFESSIONAL}&serviceId=${SERVICE}&date=${date}`, {
  as: receptionist,
  label: 'I7',
  show: (json) => `${localTime(slots[0])} free again? ${json.data.slots.some((slot) => slot.startAt === slots[0]) ? 'yes' : 'NO'}`,
});
await call('POST', `/api/v1/appointments/${appointmentId}/cancel`, { as: receptionist, label: 'cancel the rescheduled one', body: { reason: 'demo' } });

await step('Cancel with reason and author', 'RF11, I7');
await call('POST', `/api/v1/appointments/${currentId}/cancel`, {
  as: receptionist,
  body: { reason: 'Patient asked to cancel' },
  show: (json) => `status=${json.data.status}, reason="${json.data.cancellation.reason}", cancelledBy=${json.data.cancellation.cancelledBy}`,
});

await step('Outcome after the start time, and the clinical note of its professional', 'RF12, RF15, RF18');
let pending = null;
for (let days = 1; days <= 30 && pending === null; days += 1) {
  const agenda = await fetch(`${GATEWAY}/api/v1/agenda?date=${localDate(-days)}`, { headers: { Authorization: `Bearer ${professional}` } }).then((response) => response.json());
  pending = agenda.data?.items.find((item) => item.status === 'booked') ?? null;
}
if (pending === null) {
  console.log(dim('  no past appointment with a pending outcome left in the seed (recreate the volume for a fresh demo)'));
} else {
  await call('POST', `/api/v1/appointments/${pending.appointmentId}/outcome`, { as: receptionist, label: 'past appointment, outcome pending', body: { outcome: 'attended' }, show: (json) => `status=${json.data.status}` });
  await call('POST', `/api/v1/appointments/${pending.appointmentId}/clinical-note`, { as: professional, label: 'its professional', body: { content: 'Stable. Review in 4 weeks.' }, show: (json) => `note ${json.data.noteId} (content not echoed)` });
  await call('GET', `/api/v1/appointments/${pending.appointmentId}/clinical-note`, { as: receptionist, label: 'receptionist (denied, audited)' });
  await call('GET', `/api/v1/audit-log?patientId=${pending.patientId}&resourceType=clinical_note&limit=5`, {
    as: admin,
    label: 'RF19 clinic admin',
    show: (json) => json.data.map((entry) => `${entry.action}/${entry.outcome} by ${entry.actorRole}`).join(', '),
  });
}
await call('POST', `/api/v1/appointments/${currentId}/outcome`, { as: receptionist, label: 'future appointment', body: { outcome: 'attended' } });

await step('Another clinic cannot see any of this', 'acceptance criterion 4, I5 (discriminator + RLS)');
await call('GET', `/api/v1/patients/${patientId}`, { as: foreign, label: 'clinic 2' });
await call('GET', `/api/v1/patients/${patientId}`, { as: foreign, label: 'clinic 2 + X-Tenant-Id header', headers: { 'X-Tenant-Id': '10000000-0000-4000-8000-000000000001' } });
await call('GET', '/api/v1/patients?tenantId=10000000-0000-4000-8000-000000000001', { as: foreign, label: 'clinic 2 + ?tenantId=' });
await call('GET', `/api/v1/patients/${patientId}/appointments`, { as: foreign, label: 'clinic 2 history', show: (json) => `${json.data.length} appointments (reveals nothing)` });

await step('History, day agenda and counts', 'RF16, RF20, RF21');
await call('GET', `/api/v1/patients/${patientId}/appointments`, { as: receptionist, label: 'RF16', show: (json) => json.data.map((item) => item.status).join(', ') });
await call('GET', `/api/v1/agenda?date=${date}`, { as: receptionist, label: 'RF20 clinic-wide', show: (json) => `${json.data.items.length} items` });
await call('GET', `/api/v1/agenda?date=${date}`, { as: professional, label: 'RF20 own agenda', show: (json) => `${json.data.items.length} items, all of Dr. Rojas` });
await call('GET', `/api/v1/reports/appointment-status-counts?from=${date}&to=${date}`, { as: receptionist, label: 'RF21', show: (json) => JSON.stringify(json.data.counts) });

if (OUTAGE) {
  await step('Redis goes down: the system degrades to PostgreSQL and says so', 'never fake a hit');
  execFileSync('docker', ['compose', 'stop', 'redis'], { stdio: 'ignore' });
  try {
    await call('GET', `/api/v1/availability?professionalId=${PROFESSIONAL}&serviceId=${SERVICE}&date=${date}`, { as: receptionist, show: showSlots });
  } finally {
    execFileSync('docker', ['compose', 'up', '-d', '--wait', '--no-deps', 'redis'], { stdio: 'ignore' });
  }
  console.log(dim('  redis restarted'));
}

console.log(`\n${bold(green('Demo complete.'))} ${dim('Automated evidence of every step: npm test.')}`);
rl?.close();
