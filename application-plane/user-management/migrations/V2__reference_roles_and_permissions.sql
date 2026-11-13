-- =============================================================================
-- user-management (database medicitas_user, schema identity)
-- Reference data: the permission matrix as data.
-- Not tenant-scoped. The identity library holds the same mapping in code; a
-- contract test asserts both are identical.
-- =============================================================================

CREATE TABLE roles (
    code         text PRIMARY KEY,
    scope        text NOT NULL,
    description  text NOT NULL,
    CONSTRAINT roles_code_known CHECK (code IN ('platform_admin', 'clinic_admin', 'receptionist', 'health_professional')),
    CONSTRAINT roles_scope CHECK (scope IN ('platform', 'tenant'))
);

COMMENT ON TABLE roles IS 'MediCitas roles (Keycloak realm roles). One role per user.';
COMMENT ON COLUMN roles.code IS 'Realm role name carried in realm_access.roles.';
COMMENT ON COLUMN roles.scope IS 'platform: no tenant; tenant: exactly one tenant.';

CREATE TABLE permissions (
    code          text PRIMARY KEY,
    description   text NOT NULL,
    requirements  text NOT NULL,
    CONSTRAINT permissions_code_format CHECK (code ~ '^[a-z-]+:[a-z-]+$')
);

COMMENT ON TABLE permissions IS 'Domain permissions that roles are translated into (RF17).';
COMMENT ON COLUMN permissions.requirements IS 'Functional requirements covered by the permission.';

CREATE TABLE role_permissions (
    role_code        text NOT NULL REFERENCES roles (code),
    permission_code  text NOT NULL REFERENCES permissions (code),
    CONSTRAINT role_permissions_pk PRIMARY KEY (role_code, permission_code)
);

COMMENT ON TABLE role_permissions IS 'Permission matrix: which role grants which permission.';

INSERT INTO roles (code, scope, description) VALUES
    ('platform_admin',      'platform', 'SaaS operator: onboards clinics; no access to clinical data.'),
    ('clinic_admin',        'tenant',   'Manages users, professionals, catalog; only role that reads the audit log.'),
    ('receptionist',        'tenant',   'Registers patients and operates the agenda.'),
    ('health_professional', 'tenant',   'Consults own agenda and writes clinical notes of attended appointments.');

INSERT INTO permissions (code, description, requirements) VALUES
    ('tenants:onboard',      'Onboard a clinic with its first admin',                     'RF1'),
    ('tenants:read',         'Read tenants and onboarding operations',                    'RF1'),
    ('users:manage',         'Create, deactivate and re-role clinic users',               'RF2'),
    ('catalog:manage',       'Maintain specialties, services and professionals',          'RF3, RF4'),
    ('catalog:read',         'Read specialties, services and professionals',              'RF3, RF4'),
    ('schedule:manage',      'Define schedules and blocks of any professional',           'RF5, RF6'),
    ('schedule:manage-own',  'Define own schedule and blocks',                            'RF5, RF6'),
    ('schedule:read',        'Read schedules, blocks and conflicts',                      'RF5, RF6'),
    ('availability:read',    'Query availability',                                        'RF7, RF8'),
    ('appointments:book',    'Book, reschedule and cancel appointments',                  'RF9, RF10, RF11'),
    ('appointments:outcome', 'Record appointment outcome',                                'RF12'),
    ('appointments:read',    'Read appointment details',                                  'RF13'),
    ('patients:write',       'Register and update patients',                              'RF14'),
    ('patients:read',        'Read patients',                                             'RF14'),
    ('clinical-notes:own',   'Write and read notes of own attended appointments',         'RF15'),
    ('patient-history:read', 'Read the appointment history of a patient',                 'RF16'),
    ('audit:read',           'Query the audit log',                                       'RF19'),
    ('agenda:read',          'Read the clinic-wide day agenda',                           'RF20'),
    ('agenda:read-own',      'Read own day agenda',                                       'RF20'),
    ('reports:read',         'Count appointments by status',                              'RF21');

INSERT INTO role_permissions (role_code, permission_code) VALUES
    ('platform_admin', 'tenants:onboard'),
    ('platform_admin', 'tenants:read'),
    ('clinic_admin', 'users:manage'),
    ('clinic_admin', 'catalog:manage'),
    ('clinic_admin', 'catalog:read'),
    ('clinic_admin', 'schedule:manage'),
    ('clinic_admin', 'schedule:read'),
    ('clinic_admin', 'availability:read'),
    ('clinic_admin', 'appointments:book'),
    ('clinic_admin', 'appointments:outcome'),
    ('clinic_admin', 'appointments:read'),
    ('clinic_admin', 'patients:write'),
    ('clinic_admin', 'patients:read'),
    ('clinic_admin', 'patient-history:read'),
    ('clinic_admin', 'audit:read'),
    ('clinic_admin', 'agenda:read'),
    ('clinic_admin', 'reports:read'),
    ('receptionist', 'catalog:read'),
    ('receptionist', 'schedule:read'),
    ('receptionist', 'availability:read'),
    ('receptionist', 'appointments:book'),
    ('receptionist', 'appointments:outcome'),
    ('receptionist', 'appointments:read'),
    ('receptionist', 'patients:write'),
    ('receptionist', 'patients:read'),
    ('receptionist', 'patient-history:read'),
    ('receptionist', 'agenda:read'),
    ('receptionist', 'reports:read'),
    ('health_professional', 'catalog:read'),
    ('health_professional', 'schedule:manage-own'),
    ('health_professional', 'schedule:read'),
    ('health_professional', 'availability:read'),
    ('health_professional', 'appointments:outcome'),
    ('health_professional', 'appointments:read'),
    ('health_professional', 'patients:read'),
    ('health_professional', 'clinical-notes:own'),
    ('health_professional', 'patient-history:read'),
    ('health_professional', 'agenda:read-own');
