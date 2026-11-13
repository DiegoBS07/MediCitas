#!/usr/bin/env node
/**
 * Generates realm-medicitas.json from the same deterministic identifiers as the
 * database seeds, so Keycloak subjects and users.keycloak_subject match.
 *
 *   node shared-plane/identity/keycloak/generate-realm.mjs
 *
 * Secrets are NOT written here: the file uses Keycloak import placeholders (${ENV_VAR}) that are
 * resolved from the container environment at import time.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pad = (value, length) => String(value).padStart(length, '0');
const tenantId = (t) => `10000000-0000-4000-8000-${pad(t, 12)}`;
const subjectId = (t, n) => `30000000-0000-4000-8000-${pad(t, 8)}${pad(n, 4)}`;

const clinics = [
  { t: 1, slug: 'clinica-san-jose', domain: 'sanjose.medicitas.test' },
  { t: 2, slug: 'centro-medico-heredia', domain: 'heredia.medicitas.test' },
  { t: 3, slug: 'clinica-del-istmo', domain: 'istmo.medicitas.test' },
];

const clinicUsers = [
  [1, 1, 'clinic_admin', 'Ana', 'Mora'],
  [1, 2, 'receptionist', 'Carlos', 'Jiménez'],
  [1, 3, 'receptionist', 'Laura', 'Vargas'],
  [1, 11, 'health_professional', 'Andrés', 'Rojas'],
  [1, 12, 'health_professional', 'Sofía', 'Castro'],
  [1, 13, 'health_professional', 'Javier', 'Méndez'],
  [2, 1, 'clinic_admin', 'Mariela', 'Quesada'],
  [2, 2, 'receptionist', 'Diego', 'Araya'],
  [2, 3, 'receptionist', 'Paola', 'Chaves'],
  [2, 11, 'health_professional', 'Gabriela', 'Herrera'],
  [2, 12, 'health_professional', 'Esteban', 'Ulate'],
  [2, 13, 'health_professional', 'Natalia', 'Brenes'],
  [3, 1, 'clinic_admin', 'Ricardo', 'Pinzón'],
  [3, 2, 'receptionist', 'Yesenia', 'Batista'],
  [3, 3, 'receptionist', 'Luis', 'Sánchez'],
  [3, 11, 'health_professional', 'Omar', 'Delgado'],
  [3, 12, 'health_professional', 'Itzel', 'Camargo'],
  [3, 13, 'health_professional', 'Rubén', 'Arosemena'],
];

const ascii = (value) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const users = [
  {
    id: '30000000-0000-4000-8000-000000000000',
    username: 'platform.admin@medicitas.test',
    email: 'platform.admin@medicitas.test',
    firstName: 'Platform',
    lastName: 'Administrator',
    enabled: true,
    emailVerified: true,
    realmRoles: ['platform_admin'],
    credentials: [{ type: 'password', value: '${MEDICITAS_PLATFORM_ADMIN_PASSWORD}', temporary: false }],
  },
  ...clinicUsers.map(([t, n, role, firstName, lastName]) => {
    const clinic = clinics.find((c) => c.t === t);
    const email = `${ascii(firstName)}.${ascii(lastName)}@${clinic.domain}`;
    return {
      id: subjectId(t, n),
      username: email,
      email,
      firstName,
      lastName,
      enabled: true,
      emailVerified: true,
      attributes: { tenant_id: [tenantId(t)] },
      realmRoles: [role],
      groups: [`/tenants/${clinic.slug}`],
      credentials: [{ type: 'password', value: '${MEDICITAS_DEMO_USER_PASSWORD}', temporary: false }],
    };
  }),
  {
    username: 'service-account-medicitas-provisioner',
    enabled: true,
    serviceAccountClientId: 'medicitas-provisioner',
    clientRoles: {
      'realm-management': ['manage-users', 'view-users', 'query-users', 'query-groups', 'view-realm'],
    },
  },
];

// Declarative user profile (Keycloak 26). tenant_id is ADMIN-ONLY: a user can never set or change
// their own clinic (I5). displayName values avoid ${...} so they are not taken as import placeholders.
const adminOnly = { view: ['admin'], edit: ['admin'] };
const userProfile = {
  attributes: [
    {
      name: 'username',
      displayName: 'Username',
      validations: { length: { min: 3, max: 255 }, 'username-prohibited-characters': {}, 'up-username-not-idn-homograph': {} },
      permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] },
      multivalued: false,
    },
    {
      name: 'email',
      displayName: 'Email',
      validations: { email: {}, length: { max: 255 } },
      required: { roles: ['user'] },
      permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] },
      multivalued: false,
    },
    {
      name: 'firstName',
      displayName: 'First name',
      validations: { length: { max: 255 }, 'person-name-prohibited-characters': {} },
      required: { roles: ['user'] },
      permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] },
      multivalued: false,
    },
    {
      name: 'lastName',
      displayName: 'Last name',
      validations: { length: { max: 255 }, 'person-name-prohibited-characters': {} },
      required: { roles: ['user'] },
      permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] },
      multivalued: false,
    },
    {
      name: 'tenant_id',
      displayName: 'Clinic (tenant) identifier',
      validations: {
        pattern: { pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'error-message': 'invalid tenant id' },
      },
      permissions: adminOnly,
      multivalued: false,
    },
    {
      name: 'medicitas_saga_id',
      displayName: 'Provisioning saga identifier',
      permissions: adminOnly,
      multivalued: false,
    },
  ],
  groups: [{ name: 'user-metadata', displayHeader: 'User metadata', displayDescription: 'Attributes, which refer to user metadata' }],
  unmanagedAttributePolicy: 'ADMIN_VIEW',
};

const realm = {
  realm: 'medicitas',
  displayName: 'MediCitas',
  enabled: true,
  sslRequired: 'external',
  registrationAllowed: false,
  loginWithEmailAllowed: true,
  duplicateEmailsAllowed: false,
  resetPasswordAllowed: false,
  editUsernameAllowed: false,
  bruteForceProtected: true,
  permanentLockout: false,
  failureFactor: 30,
  accessTokenLifespan: 300,
  ssoSessionIdleTimeout: 1800,
  ssoSessionMaxLifespan: 36000,
  roles: {
    realm: [
      { name: 'platform_admin', description: 'SaaS operator: onboards clinics; no access to clinical data.' },
      { name: 'clinic_admin', description: 'Manages users, professionals and catalog; reads the audit log.' },
      { name: 'receptionist', description: 'Registers patients and operates the agenda.' },
      { name: 'health_professional', description: 'Consults own agenda and writes clinical notes.' },
    ],
  },
  groups: [
    {
      name: 'tenants',
      attributes: {},
      subGroups: clinics.map((c) => ({ name: c.slug, attributes: { tenant_id: [tenantId(c.t)] } })),
    },
  ],
  clients: [
    {
      clientId: 'medicitas-api',
      name: 'MediCitas API (audience)',
      description: 'Resource identifier: access tokens must carry aud=medicitas-api.',
      enabled: true,
      publicClient: false,
      bearerOnly: false,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      protocol: 'openid-connect',
    },
    {
      clientId: 'medicitas-cli',
      name: 'MediCitas CLI (local evaluation only)',
      description: 'Public client with direct access grants for scripts, the request collection and tests.',
      enabled: true,
      publicClient: true,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: true,
      serviceAccountsEnabled: false,
      protocol: 'openid-connect',
      fullScopeAllowed: true,
      defaultClientScopes: ['basic', 'roles', 'profile', 'email', 'web-origins', 'acr'],
      optionalClientScopes: [],
      attributes: { 'oauth2.device.authorization.grant.enabled': 'false' },
      protocolMappers: [
        {
          name: 'tenant_id',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-usermodel-attribute-mapper',
          consentRequired: false,
          config: {
            'user.attribute': 'tenant_id',
            'claim.name': 'tenant_id',
            'jsonType.label': 'String',
            multivalued: 'false',
            'access.token.claim': 'true',
            'id.token.claim': 'false',
            'userinfo.token.claim': 'true',
            'introspection.token.claim': 'true',
          },
        },
        {
          name: 'medicitas-api-audience',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-audience-mapper',
          consentRequired: false,
          config: {
            'included.client.audience': 'medicitas-api',
            'access.token.claim': 'true',
            'id.token.claim': 'false',
            'introspection.token.claim': 'true',
          },
        },
      ],
    },
    {
      clientId: 'medicitas-provisioner',
      name: 'MediCitas provisioner (service account)',
      description: 'Client credentials for onboarding-orchestrator and user-management-orchestrator (Admin REST API).',
      enabled: true,
      publicClient: false,
      secret: '${MEDICITAS_PROVISIONER_CLIENT_SECRET}',
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: true,
      protocol: 'openid-connect',
    },
  ],
  users,
  components: {
    'org.keycloak.userprofile.UserProfileProvider': [
      { providerId: 'declarative-user-profile', subComponents: {}, config: { 'kc.user.profile.config': [JSON.stringify(userProfile)] } },
    ],
  },
};

const target = fileURLToPath(new URL('./realm-medicitas.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(realm, null, 2)}\n`);
console.log(`written ${target} (${users.length} users)`);
