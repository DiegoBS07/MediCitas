import { randomUUID } from 'node:crypto';
import { api, eventually, expectStatus } from './api.js';

/**
 * Per-run acceptance fixture. Every run onboards its OWN clinic through the public API (RF1), creates
 * its staff through RF2 and its catalog through RF3/RF4, so acceptance tests never read or modify
 * the demo clinics' data (except where a test deliberately targets them, e.g. isolation).
 *
 * Keycloak issues every token (password grant of the local-evaluation client medicitas-cli). RF2
 * creates users with a TEMPORARY password; the fixture then sets a permanent one through the
 * Keycloak Admin REST API with the provisioner service account, standing in for the user completing
 * the "update password" step of their first login. Passwords are random per run and never printed.
 */

export type ClinicRole = 'clinic_admin' | 'receptionist' | 'health_professional';

export interface StaffMember {
  readonly userId: string;
  readonly subject: string;
  readonly email: string;
  readonly password: string;
  readonly role: ClinicRole;
}

export interface AcceptanceFixture {
  readonly runId: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly timezone: string;
  readonly emailDomain: string;
  readonly admin: StaffMember;
  readonly receptionists: readonly [StaffMember, StaffMember];
  readonly specialtyId: string;
  /** Active 30-minute service of the run clinic. */
  readonly serviceId: string;
}

export const TIMEZONE = 'America/Costa_Rica'; // no DST: local = UTC-6

// ---------------------------------------------------------------------------
// Keycloak (token endpoint + Admin REST with the provisioner service account)
// ---------------------------------------------------------------------------

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Missing ${name}: run "cp .env.example .env" first.`);
  return value;
}

const realm = (): string => `${required('KEYCLOAK_PUBLIC_URL')}/realms/medicitas`;
const adminBase = (): string => `${required('KEYCLOAK_PUBLIC_URL')}/admin/realms/medicitas`;

export async function passwordToken(username: string, password: string): Promise<string> {
  const response = await fetch(`${realm()}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'medicitas-cli', username, password }),
  });
  const body = (await response.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || body.access_token === undefined) {
    throw new Error(`token request for ${username} failed with HTTP ${response.status} (${body.error ?? ''}: ${body.error_description ?? ''})`);
  }
  return body.access_token;
}

async function provisionerToken(): Promise<string> {
  const response = await fetch(`${realm()}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'medicitas-provisioner',
      client_secret: required('MEDICITAS_PROVISIONER_CLIENT_SECRET'),
    }),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!response.ok || body.access_token === undefined) throw new Error(`provisioner token failed with HTTP ${response.status}`);
  return body.access_token;
}

async function keycloakAdmin(method: string, path: string, body?: unknown): Promise<Response> {
  const token = await provisionerToken();
  return fetch(`${adminBase()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Sub-groups of /tenants with their tenant_id attribute and member usernames (realm integrity checks). */
export async function clinicGroups(): Promise<{ name: string; tenantId: string | undefined; members: string[] }[]> {
  const parent = (await (await keycloakAdmin('GET', '/group-by-path/tenants')).json()) as { id: string };
  const children = (await (await keycloakAdmin('GET', `/groups/${parent.id}/children?max=500&briefRepresentation=false`)).json()) as {
    id: string;
    name: string;
    attributes?: Record<string, string[]>;
  }[];
  return Promise.all(
    children.map(async (group) => ({
      name: group.name,
      tenantId: group.attributes?.['tenant_id']?.[0],
      members: ((await (await keycloakAdmin('GET', `/groups/${group.id}/members?max=500`)).json()) as { username: string }[]).map((member) => member.username),
    })),
  );
}

/** Simulates the first-login password change: permanent password, no pending required action. */
export async function setPermanentPassword(subject: string, password: string): Promise<void> {
  const response = await keycloakAdmin('PUT', `/users/${subject}/reset-password`, { type: 'password', value: password, temporary: false });
  if (response.status !== 204) throw new Error(`reset-password failed with HTTP ${response.status}`);
}

/**
 * Removes the run's Keycloak users and the run clinic's group /tenants/<slug> (database rows are
 * history and stay). The group is looked up by its exact path and deleted only if its tenant_id
 * attribute is the run tenant: an attribute search returns the hierarchy from the /tenants parent,
 * which must never be deleted (it holds every clinic group).
 */
export async function deleteRunIdentities(fixture: Pick<AcceptanceFixture, 'emailDomain' | 'tenantId' | 'slug'>): Promise<void> {
  const users = (await (await keycloakAdmin('GET', `/users?search=${encodeURIComponent(fixture.emailDomain)}&max=200`)).json()) as { id: string; email?: string }[];
  for (const user of users) {
    if (user.email?.endsWith(`@${fixture.emailDomain}`) === true) await keycloakAdmin('DELETE', `/users/${user.id}`);
  }
  const response = await keycloakAdmin('GET', `/group-by-path/tenants/${encodeURIComponent(fixture.slug)}`);
  if (response.status !== 200) return;
  const group = (await response.json()) as { id: string; path?: string; attributes?: Record<string, string[]> };
  if (group.path === `/tenants/${fixture.slug}` && group.attributes?.['tenant_id']?.includes(fixture.tenantId) === true) {
    await keycloakAdmin('DELETE', `/groups/${group.id}`);
  }
}

// ---------------------------------------------------------------------------
// Tokens (cached 4 minutes; Keycloak access tokens live 5)
// ---------------------------------------------------------------------------

const tokenCache = new Map<string, { readonly token: Promise<string>; readonly expiresAt: number }>();

/**
 * One in-flight token request per user. Keycloak's brute-force detector (realm bruteForceProtected)
 * rejects one of two CONCURRENT password grants of the same user as "Invalid user credentials"
 * (event user_temporarily_disabled), so parallel callers share the same request.
 */
export async function tokenOf(member: Pick<StaffMember, 'email' | 'password'>): Promise<string> {
  const cached = tokenCache.get(member.email);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.token;
  const token = passwordToken(member.email, member.password);
  tokenCache.set(member.email, { token, expiresAt: Date.now() + 4 * 60_000 });
  token.catch(() => tokenCache.delete(member.email));
  return token;
}

/** Seeded demo logins, used only by isolation and authorization tests. */
export const SEEDED = {
  platformAdmin: 'platform.admin@medicitas.test',
  clinic1Admin: 'ana.mora@sanjose.medicitas.test',
  clinic1Receptionist: 'carlos.jimenez@sanjose.medicitas.test',
  clinic1Professional: 'andres.rojas@sanjose.medicitas.test',
  clinic2Admin: 'mariela.quesada@heredia.medicitas.test',
  clinic2Receptionist: 'diego.araya@heredia.medicitas.test',
} as const;

export async function seededToken(user: keyof typeof SEEDED): Promise<string> {
  const password = user === 'platformAdmin' ? required('MEDICITAS_PLATFORM_ADMIN_PASSWORD') : required('MEDICITAS_DEMO_USER_PASSWORD');
  return tokenOf({ email: SEEDED[user], password });
}

const newPassword = (): string => `Acc-${randomUUID()}`;

// ---------------------------------------------------------------------------
// RF1 / RF2 / RF3 / RF4 / RF5 through the gateway
// ---------------------------------------------------------------------------

export async function onboardClinic(runId: string): Promise<AcceptanceFixture> {
  const emailDomain = `${runId}.acc.medicitas.test`;
  const slug = `acc-${runId}`;
  const adminPassword = newPassword();
  const adminEmail = `admin@${emailDomain}`;
  const onboarded = expectStatus(
    await api<{ data: { tenantId: string; status: string; firstAdmin: { subject: string } } }>('POST', '/api/v1/tenants', {
      token: await seededToken('platformAdmin'),
      idempotencyKey: true,
      body: {
        name: `Acceptance Clinic ${runId}`,
        slug,
        timezone: TIMEZONE,
        firstAdmin: { email: adminEmail, firstName: 'Acceptance', lastName: 'Admin', temporaryPassword: newPassword() },
      },
    }),
    201,
    'RF1 onboarding',
  );
  const tenantId = onboarded.body.data.tenantId;
  await setPermanentPassword(onboarded.body.data.firstAdmin.subject, adminPassword);
  const adminToken = await tokenOf({ email: adminEmail, password: adminPassword });
  // The first admin is registered by user-management from the TenantOnboarded event (eventual).
  const adminUser = await eventually(async () => {
    const users = await api<{ data: { userId: string; email: string }[] }>('GET', '/api/v1/users?role=clinic_admin', { token: adminToken });
    return users.status === 200 ? users.body.data.find((user) => user.email === adminEmail) : undefined;
  }, 20_000, 250, 'first admin replicated');
  const admin: StaffMember = { userId: adminUser.userId, subject: onboarded.body.data.firstAdmin.subject, email: adminEmail, password: adminPassword, role: 'clinic_admin' };

  const [first, second] = await Promise.all([createStaff(admin, 'receptionist', emailDomain, 'Reception One'), createStaff(admin, 'receptionist', emailDomain, 'Reception Two')]);
  const specialty = await eventually(async () => {
    const created = await api<{ data: { specialtyId: string } }>('POST', '/api/v1/specialties', { token: adminToken, body: { name: `General Medicine ${runId}` } });
    return created.status === 201 ? created.body.data : undefined;
  }, 20_000, 250, 'catalog ready for the new clinic');
  const service = expectStatus(
    await api<{ data: { serviceId: string } }>('POST', '/api/v1/services', {
      token: adminToken,
      body: { name: 'General consultation', specialtyId: specialty.specialtyId, durationMinutes: 30 },
    }),
    201,
    'RF3 service',
  );
  return {
    runId,
    tenantId,
    slug,
    timezone: TIMEZONE,
    emailDomain,
    admin,
    receptionists: [first, second],
    specialtyId: specialty.specialtyId,
    serviceId: service.body.data.serviceId,
  };
}

/** RF2: creates an active clinic user (Keycloak identity + record) and makes it able to log in. */
export async function createStaff(admin: StaffMember, role: ClinicRole, emailDomain: string, name: string): Promise<StaffMember> {
  const email = `${role.replace('_', '-')}.${randomUUID().slice(0, 8)}@${emailDomain}`;
  const [firstName, ...rest] = name.split(' ');
  const created = expectStatus(
    await api<{ data: { userId: string; keycloakSubject: string; status: string } }>('POST', '/api/v1/users', {
      token: await tokenOf(admin),
      idempotencyKey: true,
      body: { email, firstName, lastName: rest.join(' ') || 'Acceptance', role, temporaryPassword: newPassword() },
    }),
    201,
    `RF2 create ${role}`,
  );
  const password = newPassword();
  await setPermanentPassword(created.body.data.keycloakSubject, password);
  return { userId: created.body.data.userId, subject: created.body.data.keycloakSubject, email, password, role };
}

export interface TestProfessional {
  readonly professionalId: string;
  readonly member: StaffMember;
  readonly serviceIds: readonly string[];
}

export const DEFAULT_WEEK = [1, 2, 3, 4, 5, 6, 7].flatMap((dayOfWeek) => [
  { dayOfWeek, startTime: '08:00', endTime: '12:00' },
  { dayOfWeek, startTime: '13:00', endTime: '17:00' },
]);

/**
 * RF2 + RF4 + RF5: a fresh health professional of the run clinic, associated with the given services
 * and working every day 08:00–12:00 and 13:00–17:00 local (split day). Each test file books on its own
 * professionals, so files never compete for slots.
 */
export async function createProfessional(
  fixture: AcceptanceFixture,
  options: { readonly name?: string; readonly serviceIds?: readonly string[]; readonly blocks?: readonly { dayOfWeek: number; startTime: string; endTime: string }[] } = {},
): Promise<TestProfessional> {
  const name = options.name ?? `Dr. Test ${randomUUID().slice(0, 4)}`;
  const member = await createStaff(fixture.admin, 'health_professional', fixture.emailDomain, name);
  const adminToken = await tokenOf(fixture.admin);
  const professional = expectStatus(
    await api<{ data: { professionalId: string } }>('POST', '/api/v1/professionals', {
      token: adminToken,
      body: { userId: member.userId, specialtyId: fixture.specialtyId, displayName: name, licenseNumber: `ACC-${randomUUID().slice(0, 8)}` },
    }),
    201,
    'RF4 professional',
  );
  const professionalId = professional.body.data.professionalId;
  const serviceIds = options.serviceIds ?? [fixture.serviceId];
  expectStatus(await api('PUT', `/api/v1/professionals/${professionalId}/services`, { token: adminToken, body: { serviceIds } }), 200, 'RF4 associations');
  // The scheduler learns about the professional from catalog events (replica).
  await eventually(async () => {
    const result = await api('PUT', `/api/v1/professionals/${professionalId}/weekly-schedule`, { token: adminToken, body: { blocks: options.blocks ?? DEFAULT_WEEK } });
    return result.status === 200 ? true : undefined;
  }, 20_000, 250, 'RF5 schedule on the replicated professional');
  return { professionalId, member, serviceIds };
}

let patientCounter = 0;

/** RF14: registers a patient of the run clinic. */
export async function createPatient(token: string, label = 'Patient'): Promise<string> {
  patientCounter += 1;
  const created = expectStatus(
    await api<{ data: { patientId: string } }>('POST', '/api/v1/patients', {
      token,
      body: {
        identificationType: 'passport',
        identificationNumber: `ACC-${randomUUID().slice(0, 12)}`,
        firstName: label,
        lastName: `Test ${patientCounter}`,
        birthDate: '1990-05-17',
        contact: { email: `patient.${randomUUID().slice(0, 6)}@example.test`, phone: '+50688880000' },
      },
    }),
    201,
    'RF14 patient',
  );
  return created.body.data.patientId;
}
