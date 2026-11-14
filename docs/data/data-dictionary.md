# MediCitas — Data Dictionary

> Generated from the PostgreSQL catalog by `database/tools/generate-data-dictionary.sh`.
> Do not edit by hand: descriptions come from `COMMENT ON` statements in the migrations.
> Reliability tables (`outbox_messages`, `inbox_messages`, `idempotency_records`) are identical in every database and are documented once, under tenant-management.

## tenant-management — database `medicitas_tenant`, schema `tenancy`

### `idempotency_records`

Idempotency-Key records: replay of the stored response for the same key and body; 422 for the same key with a different body. Retained 24 h.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |  |
| `tenant_id` | `uuid` | yes |  | Scope: the caller tenant, or NULL for platform-scoped requests. |
| `http_method` | `text` | no |  |  |
| `route_template` | `text` | no |  | Express route template, e.g. /api/v1/appointments/:appointmentId/cancel. |
| `idempotency_key` | `text` | no |  |  |
| `request_hash` | `text` | no |  | SHA-256 of the canonical JSON request body. |
| `status` | `text` | no | `'in_progress'::text` | in_progress while the first request runs; completed once the response is stored. |
| `operation_id` | `uuid` | yes |  | Saga/operation identifier for long-running requests (202 Location). |
| `response_status` | `integer` | yes |  | Stored HTTP status of the first completed response. |
| `response_body` | `jsonb` | yes |  | Stored response body (problem+json or data). |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `expires_at` | `timestamp with time zone` | no | `(clock_timestamp() + '24:00:00'::interval)` | Retention limit; expired rows are deleted by the worker. |

**Constraints**

- `idempotency_records_completed_has_response`: `CHECK (((status = 'in_progress'::text) OR (((response_status >= 200) AND (response_status <= 599)) AND (response_body IS NOT NULL))))`
- `idempotency_records_key_format`: `CHECK ((idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'::text))`
- `idempotency_records_method`: `CHECK ((http_method = ANY (ARRAY['POST'::text, 'PUT'::text, 'PATCH'::text, 'DELETE'::text])))`
- `idempotency_records_pkey`: `PRIMARY KEY (id)`
- `idempotency_records_scope_unique`: `UNIQUE NULLS NOT DISTINCT (tenant_id, http_method, route_template, idempotency_key)`
- `idempotency_records_status`: `CHECK ((status = ANY (ARRAY['in_progress'::text, 'completed'::text])))`
- `idempotency_records_tenant_required`: `CHECK (((NOT false) OR (tenant_id IS NOT NULL)))`

**Indexes**

- `idempotency_records_expires_at_idx`: `CREATE INDEX idempotency_records_expires_at_idx ON tenancy.idempotency_records USING btree (expires_at)` — Retention clean-up by expiry.
- `idempotency_records_pkey`: `CREATE UNIQUE INDEX idempotency_records_pkey ON tenancy.idempotency_records USING btree (id)`
- `idempotency_records_scope_unique`: `CREATE UNIQUE INDEX idempotency_records_scope_unique ON tenancy.idempotency_records USING btree (tenant_id, http_method, route_template, idempotency_key) NULLS NOT DISTINCT`

**Row-Level Security**: enabled + forced — policies: `idempotency_actor_tenant` (ALL), `idempotency_worker_cleanup` (ALL)


### `inbox_messages`

Consumer de-duplication: one row per (consumer queue, messageId), inserted in the same transaction as the effects.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `consumer` | `text` | no |  | Logical consumer (queue name). |
| `message_id` | `uuid` | no |  | Envelope messageId of the processed message. |
| `tenant_id` | `uuid` | yes |  | Tenant of the processed message. |
| `message_type` | `text` | no |  | Envelope messageType. |
| `received_at` | `timestamp with time zone` | no | `clock_timestamp()` | Processing time (database clock). |
| `reply_envelope` | `jsonb` | yes |  | Reply produced for a command, re-published verbatim on duplicate delivery. |

**Constraints**

- `inbox_messages_pk`: `PRIMARY KEY (consumer, message_id)`
- `inbox_messages_tenant_required`: `CHECK (((NOT false) OR (tenant_id IS NOT NULL)))`

**Indexes**

- `inbox_messages_pk`: `CREATE UNIQUE INDEX inbox_messages_pk ON tenancy.inbox_messages USING btree (consumer, message_id)`
- `inbox_messages_received_at_idx`: `CREATE INDEX inbox_messages_received_at_idx ON tenancy.inbox_messages USING btree (received_at)` — Retention clean-up by age.

**Row-Level Security**: enabled + forced — policies: `inbox_actor_tenant` (ALL), `inbox_worker_cleanup` (ALL)


### `outbox_messages`

Transactional outbox: messages inserted in the same transaction as the state change they announce; published by the relay after a publisher confirm.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  | Equals envelope.messageId (de-duplication key for consumers). |
| `tenant_id` | `uuid` | yes |  | Tenant of the message (NULL only for control-plane platform messages). |
| `exchange` | `text` | no |  | Target RabbitMQ exchange. |
| `routing_key` | `text` | no |  | Routing key used when publishing. |
| `message_type` | `text` | no |  | Envelope messageType (duplicated for operational queries). |
| `envelope` | `jsonb` | no |  | Complete versioned envelope as published. |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `available_at` | `timestamp with time zone` | no | `clock_timestamp()` | Earliest publish time (back-off after a failed publish, or a scheduled re-send). |
| `published_at` | `timestamp with time zone` | yes |  | Set only after the broker publisher confirm; NULL means pending. |
| `attempts` | `integer` | no | `0` | Publish attempts so far. |
| `last_error` | `text` | yes |  | Last publish error (technical message, no payload data). |

**Constraints**

- `outbox_messages_attempts_non_negative`: `CHECK ((attempts >= 0))`
- `outbox_messages_envelope_id_matches`: `CHECK (((envelope ->> 'messageId'::text) = (id)::text))`
- `outbox_messages_exchange_known`: `CHECK ((exchange = ANY (ARRAY['medicitas.commands'::text, 'medicitas.queries'::text, 'medicitas.replies'::text, 'medicitas.domain-events'::text])))`
- `outbox_messages_pkey`: `PRIMARY KEY (id)`
- `outbox_messages_routing_key_format`: `CHECK ((routing_key ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*$'::text))`
- `outbox_messages_tenant_required`: `CHECK (((NOT false) OR (tenant_id IS NOT NULL)))`

**Indexes**

- `outbox_messages_pending_idx`: `CREATE INDEX outbox_messages_pending_idx ON tenancy.outbox_messages USING btree (available_at) WHERE (published_at IS NULL)` — Relay claim query: pending rows ordered by availability (FOR UPDATE SKIP LOCKED).
- `outbox_messages_pkey`: `CREATE UNIQUE INDEX outbox_messages_pkey ON tenancy.outbox_messages USING btree (id)`

**Row-Level Security**: enabled + forced — policies: `outbox_actor_insert` (INSERT), `outbox_worker_all` (ALL)


### `tenants`

Clinics (tenants) of the SaaS. Source of truth for tenant identity, name and timezone (RF1).

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  | Tenant UUID; emitted as the tenant_id claim by Keycloak and used as tenant_id in every application database. |
| `slug` | `text` | no |  | Human-readable unique identifier of the clinic (RF1 "identificador"). |
| `name` | `text` | no |  | Clinic display name. |
| `timezone` | `text` | no |  | IANA timezone of the clinic; all local dates and working hours are interpreted in it. |
| `status` | `text` | no | `'provisioning'::text` | provisioning (saga running), active, onboarding_failed (compensated). |
| `failure_reason_code` | `text` | yes |  | Stable error code of a failed onboarding. |
| `onboarding_saga_id` | `uuid` | no |  | Onboarding saga that created the tenant (idempotency of CreateTenantCommand). |
| `version` | `integer` | no | `1` | Aggregate version, carried as aggregateVersion in TenantOnboarded. |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `activated_at` | `timestamp with time zone` | yes |  | When onboarding completed. |

**Constraints**

- `tenants_active_has_activation`: `CHECK (((status = 'active'::text) = (activated_at IS NOT NULL)))`
- `tenants_failed_has_reason`: `CHECK (((status = 'onboarding_failed'::text) = (failure_reason_code IS NOT NULL)))`
- `tenants_name_length`: `CHECK (((char_length(btrim(name)) >= 2) AND (char_length(btrim(name)) <= 120)))`
- `tenants_onboarding_saga_unique`: `UNIQUE (onboarding_saga_id)`
- `tenants_pkey`: `PRIMARY KEY (id)`
- `tenants_slug_format`: `CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'::text))`
- `tenants_slug_unique`: `UNIQUE (slug)`
- `tenants_status`: `CHECK ((status = ANY (ARRAY['provisioning'::text, 'active'::text, 'onboarding_failed'::text])))`
- `tenants_version_positive`: `CHECK ((version >= 1))`

**Indexes**

- `tenants_onboarding_saga_unique`: `CREATE UNIQUE INDEX tenants_onboarding_saga_unique ON tenancy.tenants USING btree (onboarding_saga_id)`
- `tenants_pkey`: `CREATE UNIQUE INDEX tenants_pkey ON tenancy.tenants USING btree (id)`
- `tenants_slug_unique`: `CREATE UNIQUE INDEX tenants_slug_unique ON tenancy.tenants USING btree (slug)`

**Row-Level Security**: not enabled (control-plane or reference table)


## onboarding-orchestrator — database `medicitas_onboarding`, schema `onboarding`

### `saga_instances`

Onboarding saga instances (RF1). The temporary password of the first admin is never stored.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  | Saga identifier; also the public operationId. |
| `saga_type` | `text` | no | `'tenant-onboarding'::text` |  |
| `tenant_id` | `uuid` | yes |  | Tenant created by the saga (known after TenantCreatedReply). |
| `status` | `text` | no | `'started'::text` | State machine: started → tenant_created → identity_provisioned → activating → completed \| compensating → failed. |
| `request` | `jsonb` | no |  | Minimized request snapshot (name, slug, timezone, first admin identity; no password). |
| `result` | `jsonb` | yes |  | Terminal result returned by the operation resource. |
| `error_code` | `text` | yes |  | Stable error code of a failed saga. |
| `error_detail` | `text` | yes |  |  |
| `actor_subject` | `uuid` | no |  | Keycloak subject of the platform admin who started the saga. |
| `correlation_id` | `uuid` | no |  | Correlation identifier of the originating HTTP request. |
| `deadline_at` | `timestamp with time zone` | no |  | After this instant the sweeper compensates a non-terminal saga. |
| `version` | `integer` | no | `1` | Optimistic version incremented on each state change. |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `completed_at` | `timestamp with time zone` | yes |  |  |

**Constraints**

- `saga_instances_failed_has_error`: `CHECK (((status <> 'failed'::text) OR (error_code IS NOT NULL)))`
- `saga_instances_pkey`: `PRIMARY KEY (id)`
- `saga_instances_request_has_no_password`: `CHECK ((((request -> 'temporaryPassword'::text) IS NULL) AND (((request -> 'firstAdmin'::text) -> 'temporaryPassword'::text) IS NULL)))`
- `saga_instances_status`: `CHECK ((status = ANY (ARRAY['started'::text, 'tenant_created'::text, 'identity_provisioned'::text, 'activating'::text, 'completed'::text, 'compensating'::text, 'failed'::text])))`
- `saga_instances_terminal_completed_at`: `CHECK (((status = ANY (ARRAY['completed'::text, 'failed'::text])) = (completed_at IS NOT NULL)))`
- `saga_instances_type`: `CHECK ((saga_type = 'tenant-onboarding'::text))`

**Indexes**

- `saga_instances_open_deadline_idx`: `CREATE INDEX saga_instances_open_deadline_idx ON onboarding.saga_instances USING btree (deadline_at) WHERE (status <> ALL (ARRAY['completed'::text, 'failed'::text]))` — Sweeper: non-terminal sagas by deadline.
- `saga_instances_pkey`: `CREATE UNIQUE INDEX saga_instances_pkey ON onboarding.saga_instances USING btree (id)`

**Row-Level Security**: not enabled (control-plane or reference table)


### `saga_steps`

One row per saga step: dispatch, retries and the persisted reply.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `saga_id` | `uuid` | no |  |  |
| `step_name` | `text` | no |  |  |
| `status` | `text` | no | `'pending'::text` |  |
| `command_message_id` | `uuid` | yes |  | messageId of the command (re-sent with the same id for idempotency). |
| `attempts` | `integer` | no | `0` |  |
| `last_attempt_at` | `timestamp with time zone` | yes |  |  |
| `next_attempt_at` | `timestamp with time zone` | yes |  |  |
| `result` | `jsonb` | yes |  | Reply result or Keycloak artifact ids, including createdBySaga flags used by compensation. |
| `error_code` | `text` | yes |  |  |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `saga_steps_attempts_non_negative`: `CHECK ((attempts >= 0))`
- `saga_steps_name`: `CHECK ((step_name = ANY (ARRAY['create_tenant'::text, 'keycloak_group'::text, 'keycloak_admin_user'::text, 'activate_tenant'::text, 'mark_tenant_failed'::text, 'delete_keycloak_user'::text, 'delete_keycloak_group'::text])))`
- `saga_steps_pk`: `PRIMARY KEY (saga_id, step_name)`
- `saga_steps_saga_id_fkey`: `FOREIGN KEY (saga_id) REFERENCES onboarding.saga_instances(id)`
- `saga_steps_status`: `CHECK ((status = ANY (ARRAY['pending'::text, 'dispatched'::text, 'succeeded'::text, 'rejected'::text, 'failed'::text, 'compensating'::text, 'compensated'::text, 'skipped'::text])))`

**Indexes**

- `saga_steps_pk`: `CREATE UNIQUE INDEX saga_steps_pk ON onboarding.saga_steps USING btree (saga_id, step_name)`

**Row-Level Security**: not enabled (control-plane or reference table)


## user-management — database `medicitas_user`, schema `identity`

### `patients`

Patients of a clinic (RF14). Not system users. Reads/writes of contact columns produce PatientContactAccessed audit events.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  |  |
| `tenant_id` | `uuid` | no |  |  |
| `identification_type` | `text` | no |  | Kind of identity document. |
| `identification_number` | `text` | no |  | Document number, unique per tenant and type. |
| `first_name` | `text` | no |  |  |
| `last_name` | `text` | no |  |  |
| `birth_date` | `date` | no |  | Date of birth (not in the future; enforced by trigger). |
| `email` | `text` | yes |  | Contact data (audited). |
| `phone` | `text` | yes |  | Contact data (audited). |
| `address` | `text` | yes |  | Contact data (audited). |
| `status` | `text` | no | `'active'::text` |  |
| `created_by_subject` | `uuid` | no |  | Keycloak subject of the user who registered the patient. |
| `version` | `integer` | no | `1` |  |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `search_last_name` | `text` | yes | `lower(last_name)` | lower(last_name), generated and stored: lets GET /patients?q= and its ordering use indexes under RLS (lower() is not LEAKPROOF). |
| `search_first_name` | `text` | yes | `lower(first_name)` | lower(first_name), generated and stored (see search_last_name). |

**Constraints**

- `patients_address_length`: `CHECK (((address IS NULL) OR (char_length(address) <= 300)))`
- `patients_birth_date_floor`: `CHECK ((birth_date >= '1900-01-01'::date))`
- `patients_email_format`: `CHECK (((email IS NULL) OR ((char_length(email) <= 254) AND (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'::text))))`
- `patients_first_name_length`: `CHECK (((char_length(btrim(first_name)) >= 1) AND (char_length(btrim(first_name)) <= 80)))`
- `patients_identification_number_format`: `CHECK ((identification_number ~ '^[A-Za-z0-9-]{3,30}$'::text))`
- `patients_identification_type`: `CHECK ((identification_type = ANY (ARRAY['national_id'::text, 'passport'::text, 'residence_card'::text, 'other'::text])))`
- `patients_identification_unique`: `UNIQUE (tenant_id, identification_type, identification_number)`
- `patients_last_name_length`: `CHECK (((char_length(btrim(last_name)) >= 1) AND (char_length(btrim(last_name)) <= 80)))`
- `patients_phone_format`: `CHECK (((phone IS NULL) OR (phone ~ '^\+?[0-9 ()-]{7,20}$'::text)))`
- `patients_pkey`: `PRIMARY KEY (id)`
- `patients_status`: `CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))`
- `patients_tenant_id_fkey`: `FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id)`
- `patients_tenant_id_unique`: `UNIQUE (tenant_id, id)`
- `patients_version_positive`: `CHECK ((version >= 1))`

**Indexes**

- `patients_first_name_search_idx`: `CREATE INDEX patients_first_name_search_idx ON identity.patients USING btree (tenant_id, search_first_name text_pattern_ops)` — GET /patients?q= prefix search by first name.
- `patients_identification_search_idx`: `CREATE INDEX patients_identification_search_idx ON identity.patients USING btree (tenant_id, identification_number text_pattern_ops)` — GET /patients?q= prefix search by identification number within the tenant.
- `patients_identification_unique`: `CREATE UNIQUE INDEX patients_identification_unique ON identity.patients USING btree (tenant_id, identification_type, identification_number)`
- `patients_last_name_search_idx`: `CREATE INDEX patients_last_name_search_idx ON identity.patients USING btree (tenant_id, search_last_name text_pattern_ops)` — GET /patients?q= prefix search by last name (LIKE 'x%' via ~>=~/~<~, leakproof).
- `patients_listing_idx`: `CREATE INDEX patients_listing_idx ON identity.patients USING btree (tenant_id, search_last_name, id)` — GET /patients ordering and keyset pagination (search_last_name, id), default collation.
- `patients_pkey`: `CREATE UNIQUE INDEX patients_pkey ON identity.patients USING btree (id)`
- `patients_tenant_id_unique`: `CREATE UNIQUE INDEX patients_tenant_id_unique ON identity.patients USING btree (tenant_id, id)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


### `permissions`

Domain permissions that roles are translated into (RF17).

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `code` | `text` | no |  |  |
| `description` | `text` | no |  |  |
| `requirements` | `text` | no |  | Functional requirements covered by the permission. |

**Constraints**

- `permissions_code_format`: `CHECK ((code ~ '^[a-z-]+:[a-z-]+$'::text))`
- `permissions_pkey`: `PRIMARY KEY (code)`

**Indexes**

- `permissions_pkey`: `CREATE UNIQUE INDEX permissions_pkey ON identity.permissions USING btree (code)`

**Row-Level Security**: not enabled (control-plane or reference table)


### `role_permissions`

Permission matrix: which role grants which permission.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `role_code` | `text` | no |  |  |
| `permission_code` | `text` | no |  |  |

**Constraints**

- `role_permissions_permission_code_fkey`: `FOREIGN KEY (permission_code) REFERENCES identity.permissions(code)`
- `role_permissions_pk`: `PRIMARY KEY (role_code, permission_code)`
- `role_permissions_role_code_fkey`: `FOREIGN KEY (role_code) REFERENCES identity.roles(code)`

**Indexes**

- `role_permissions_pk`: `CREATE UNIQUE INDEX role_permissions_pk ON identity.role_permissions USING btree (role_code, permission_code)`

**Row-Level Security**: not enabled (control-plane or reference table)


### `roles`

MediCitas roles (Keycloak realm roles). One role per user.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `code` | `text` | no |  | Realm role name carried in realm_access.roles. |
| `scope` | `text` | no |  | platform: no tenant; tenant: exactly one tenant. |
| `description` | `text` | no |  |  |

**Constraints**

- `roles_code_known`: `CHECK ((code = ANY (ARRAY['platform_admin'::text, 'clinic_admin'::text, 'receptionist'::text, 'health_professional'::text])))`
- `roles_pkey`: `PRIMARY KEY (code)`
- `roles_scope`: `CHECK ((scope = ANY (ARRAY['platform'::text, 'tenant'::text])))`

**Indexes**

- `roles_pkey`: `CREATE UNIQUE INDEX roles_pkey ON identity.roles USING btree (code)`

**Row-Level Security**: not enabled (control-plane or reference table)


### `tenants`

Read replica of control-plane tenants (only active tenants are replicated). FK target for tenant_id.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  |  |
| `slug` | `text` | no |  |  |
| `name` | `text` | no |  |  |
| `timezone` | `text` | no |  |  |
| `status` | `text` | no |  |  |
| `version` | `integer` | no |  | aggregateVersion of the last applied event (older events are ignored). |
| `replicated_at` | `timestamp with time zone` | no | `clock_timestamp()` | When the replica row was last written. |

**Constraints**

- `tenants_pkey`: `PRIMARY KEY (id)`
- `tenants_status`: `CHECK ((status = 'active'::text))`
- `tenants_version_positive`: `CHECK ((version >= 1))`

**Indexes**

- `tenants_pkey`: `CREATE UNIQUE INDEX tenants_pkey ON identity.tenants USING btree (id)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


### `users`

Clinic users (RF2). Stores only the Keycloak subject, the tenant and the role; credentials are in Keycloak.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  |  |
| `tenant_id` | `uuid` | no |  |  |
| `keycloak_subject` | `uuid` | yes |  | Keycloak user id (token sub). NULL while provisioning. |
| `email` | `text` | no |  | Login e-mail; unique realm-wide because it is the Keycloak username. |
| `first_name` | `text` | no |  |  |
| `last_name` | `text` | no |  |  |
| `role` | `text` | no |  | Single MediCitas role within the clinic (never platform_admin). |
| `status` | `text` | no | `'provisioning'::text` | provisioning → active → inactive (logical delete); provisioning_failed after compensation. |
| `provisioning_saga_id` | `uuid` | yes |  | user-management-orchestrator saga that created the user (NULL for the onboarding first admin). |
| `version` | `integer` | no | `1` |  |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `deactivated_at` | `timestamp with time zone` | yes |  | Logical deletion timestamp. |

**Constraints**

- `users_active_has_subject`: `CHECK (((status <> ALL (ARRAY['active'::text, 'inactive'::text])) OR (keycloak_subject IS NOT NULL)))`
- `users_email_format`: `CHECK (((char_length(email) <= 254) AND (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'::text)))`
- `users_first_name_length`: `CHECK (((char_length(btrim(first_name)) >= 1) AND (char_length(btrim(first_name)) <= 80)))`
- `users_inactive_has_timestamp`: `CHECK (((status = 'inactive'::text) = (deactivated_at IS NOT NULL)))`
- `users_keycloak_subject_unique`: `UNIQUE (keycloak_subject)`
- `users_last_name_length`: `CHECK (((char_length(btrim(last_name)) >= 1) AND (char_length(btrim(last_name)) <= 80)))`
- `users_pkey`: `PRIMARY KEY (id)`
- `users_role_fkey`: `FOREIGN KEY (role) REFERENCES identity.roles(code)`
- `users_role_is_tenant_role`: `CHECK ((role <> 'platform_admin'::text))`
- `users_status`: `CHECK ((status = ANY (ARRAY['provisioning'::text, 'active'::text, 'inactive'::text, 'provisioning_failed'::text])))`
- `users_tenant_id_fkey`: `FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id)`
- `users_tenant_id_unique`: `UNIQUE (tenant_id, id)`
- `users_version_positive`: `CHECK ((version >= 1))`

**Indexes**

- `users_email_unique`: `CREATE UNIQUE INDEX users_email_unique ON identity.users USING btree (lower(email)) WHERE (status <> 'provisioning_failed'::text)` — E-mail uniqueness (EMAIL_TAKEN); case-insensitive.
- `users_keycloak_subject_unique`: `CREATE UNIQUE INDEX users_keycloak_subject_unique ON identity.users USING btree (keycloak_subject)`
- `users_pkey`: `CREATE UNIQUE INDEX users_pkey ON identity.users USING btree (id)`
- `users_tenant_id_unique`: `CREATE UNIQUE INDEX users_tenant_id_unique ON identity.users USING btree (tenant_id, id)`
- `users_tenant_listing_idx`: `CREATE INDEX users_tenant_listing_idx ON identity.users USING btree (tenant_id, last_name, first_name, id)` — GET /users keyset pagination ordered by last name, first name, id.

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


## user-management-orchestrator — database `medicitas_user_orchestrator`, schema `provisioning`

### `saga_instances`

User provisioning sagas (RF2): creation, role change, deactivation. Passwords are never stored.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  | Saga identifier; also the public operationId. |
| `tenant_id` | `uuid` | no |  |  |
| `saga_type` | `text` | no |  |  |
| `target_user_id` | `uuid` | no |  | users.id in user-management targeted by the saga (generated by the orchestrator on creation). |
| `status` | `text` | no | `'started'::text` | started → reserved → identity_provisioned → activating → completed \| compensating → failed (steps not used by a saga type are skipped). |
| `request` | `jsonb` | no |  | Minimized request snapshot (no password). |
| `result` | `jsonb` | yes |  |  |
| `error_code` | `text` | yes |  |  |
| `error_detail` | `text` | yes |  |  |
| `actor_subject` | `uuid` | no |  |  |
| `correlation_id` | `uuid` | no |  |  |
| `deadline_at` | `timestamp with time zone` | no |  | After this instant the sweeper compensates a non-terminal saga. |
| `version` | `integer` | no | `1` |  |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `completed_at` | `timestamp with time zone` | yes |  |  |

**Constraints**

- `saga_instances_failed_has_error`: `CHECK (((status <> 'failed'::text) OR (error_code IS NOT NULL)))`
- `saga_instances_pkey`: `PRIMARY KEY (id)`
- `saga_instances_request_has_no_password`: `CHECK (((request -> 'temporaryPassword'::text) IS NULL))`
- `saga_instances_status`: `CHECK ((status = ANY (ARRAY['started'::text, 'reserved'::text, 'identity_provisioned'::text, 'activating'::text, 'completed'::text, 'compensating'::text, 'failed'::text])))`
- `saga_instances_tenant_id_unique`: `UNIQUE (tenant_id, id)`
- `saga_instances_terminal_completed_at`: `CHECK (((status = ANY (ARRAY['completed'::text, 'failed'::text])) = (completed_at IS NOT NULL)))`
- `saga_instances_type`: `CHECK ((saga_type = ANY (ARRAY['user-creation'::text, 'user-role-change'::text, 'user-deactivation'::text])))`

**Indexes**

- `saga_instances_one_open_per_user`: `CREATE UNIQUE INDEX saga_instances_one_open_per_user ON provisioning.saga_instances USING btree (tenant_id, target_user_id) WHERE (status <> ALL (ARRAY['completed'::text, 'failed'::text]))` — Prevents concurrent sagas on the same user (409 OPERATION_IN_PROGRESS).
- `saga_instances_open_deadline_idx`: `CREATE INDEX saga_instances_open_deadline_idx ON provisioning.saga_instances USING btree (deadline_at) WHERE (status <> ALL (ARRAY['completed'::text, 'failed'::text]))` — Sweeper: non-terminal sagas by deadline.
- `saga_instances_pkey`: `CREATE UNIQUE INDEX saga_instances_pkey ON provisioning.saga_instances USING btree (id)`
- `saga_instances_tenant_id_unique`: `CREATE UNIQUE INDEX saga_instances_tenant_id_unique ON provisioning.saga_instances USING btree (tenant_id, id)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL), `worker_discovery` (SELECT)


### `saga_steps`

One row per saga step: dispatch, retries and persisted reply or Keycloak result.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `tenant_id` | `uuid` | no |  |  |
| `saga_id` | `uuid` | no |  |  |
| `step_name` | `text` | no |  |  |
| `status` | `text` | no | `'pending'::text` |  |
| `command_message_id` | `uuid` | yes |  | messageId of the command (re-sent with the same id for idempotency). |
| `attempts` | `integer` | no | `0` |  |
| `last_attempt_at` | `timestamp with time zone` | yes |  |  |
| `next_attempt_at` | `timestamp with time zone` | yes |  |  |
| `result` | `jsonb` | yes |  | Reply result or Keycloak artifact ids with createdBySaga flags. |
| `error_code` | `text` | yes |  |  |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `saga_steps_attempts_non_negative`: `CHECK ((attempts >= 0))`
- `saga_steps_name`: `CHECK ((step_name = ANY (ARRAY['reserve_user'::text, 'keycloak_user'::text, 'keycloak_role'::text, 'keycloak_disable'::text, 'activate_user'::text, 'change_role'::text, 'deactivate_user'::text, 'cancel_reservation'::text, 'restore_keycloak_role'::text, 'delete_keycloak_user'::text])))`
- `saga_steps_pk`: `PRIMARY KEY (saga_id, step_name)`
- `saga_steps_saga_fk`: `FOREIGN KEY (tenant_id, saga_id) REFERENCES provisioning.saga_instances(tenant_id, id)`
- `saga_steps_status`: `CHECK ((status = ANY (ARRAY['pending'::text, 'dispatched'::text, 'succeeded'::text, 'rejected'::text, 'failed'::text, 'compensating'::text, 'compensated'::text, 'skipped'::text])))`

**Indexes**

- `saga_steps_pk`: `CREATE UNIQUE INDEX saga_steps_pk ON provisioning.saga_steps USING btree (saga_id, step_name)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL), `worker_discovery` (SELECT)


## catalog-service-management — database `medicitas_catalog`, schema `catalog`

### `professional_services`

Services a professional is enabled to perform (RF4). Only services of the professional's specialty.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `tenant_id` | `uuid` | no |  |  |
| `professional_id` | `uuid` | no |  |  |
| `service_id` | `uuid` | no |  |  |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `professional_services_pk`: `PRIMARY KEY (tenant_id, professional_id, service_id)`
- `professional_services_professional_fk`: `FOREIGN KEY (tenant_id, professional_id) REFERENCES catalog.professionals(tenant_id, id)`
- `professional_services_service_fk`: `FOREIGN KEY (tenant_id, service_id) REFERENCES catalog.services(tenant_id, id)`

**Indexes**

- `professional_services_pk`: `CREATE UNIQUE INDEX professional_services_pk ON catalog.professional_services USING btree (tenant_id, professional_id, service_id)`
- `professional_services_service_idx`: `CREATE INDEX professional_services_service_idx ON catalog.professional_services USING btree (tenant_id, service_id)` — Reverse lookup: professionals offering a service (GET /professionals?serviceId=, RF8 source).

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


### `professionals`

Health professionals (RF4): practice profile of a user with role health_professional.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  |  |
| `tenant_id` | `uuid` | no |  |  |
| `user_id` | `uuid` | no |  | users.id in user-management (logical cross-service reference, validated by GetTenantUserQuery). |
| `keycloak_subject` | `uuid` | no |  | Copy of the user's Keycloak subject (deliberate denormalization: maps token sub → professional for "own" rules). |
| `specialty_id` | `uuid` | no |  |  |
| `display_name` | `text` | no |  |  |
| `license_number` | `text` | no |  | Professional license / registry number. |
| `status` | `text` | no | `'active'::text` |  |
| `version` | `integer` | no | `1` | Profile version (ProfessionalRegistered/Updated). |
| `services_version` | `integer` | no | `1` | Association-set version (ProfessionalServicesChanged); separate counter so out-of-order events cannot hide each other. |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `professionals_display_name_length`: `CHECK (((char_length(btrim(display_name)) >= 2) AND (char_length(btrim(display_name)) <= 120)))`
- `professionals_license_format`: `CHECK ((license_number ~ '^[A-Za-z0-9-]{2,30}$'::text))`
- `professionals_license_unique`: `UNIQUE (tenant_id, license_number)`
- `professionals_pkey`: `PRIMARY KEY (id)`
- `professionals_specialty_fk`: `FOREIGN KEY (tenant_id, specialty_id) REFERENCES catalog.specialties(tenant_id, id)`
- `professionals_status`: `CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))`
- `professionals_subject_unique`: `UNIQUE (keycloak_subject)`
- `professionals_tenant_id_fkey`: `FOREIGN KEY (tenant_id) REFERENCES catalog.tenants(id)`
- `professionals_tenant_id_unique`: `UNIQUE (tenant_id, id)`
- `professionals_user_unique`: `UNIQUE (tenant_id, user_id)`
- `professionals_versions_positive`: `CHECK (((version >= 1) AND (services_version >= 1)))`

**Indexes**

- `professionals_license_unique`: `CREATE UNIQUE INDEX professionals_license_unique ON catalog.professionals USING btree (tenant_id, license_number)`
- `professionals_pkey`: `CREATE UNIQUE INDEX professionals_pkey ON catalog.professionals USING btree (id)`
- `professionals_subject_unique`: `CREATE UNIQUE INDEX professionals_subject_unique ON catalog.professionals USING btree (keycloak_subject)`
- `professionals_tenant_id_unique`: `CREATE UNIQUE INDEX professionals_tenant_id_unique ON catalog.professionals USING btree (tenant_id, id)`
- `professionals_user_unique`: `CREATE UNIQUE INDEX professionals_user_unique ON catalog.professionals USING btree (tenant_id, user_id)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


### `services`

Service catalog (RF3): type of consultation; its duration defines the slot length (I4).

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  |  |
| `tenant_id` | `uuid` | no |  |  |
| `specialty_id` | `uuid` | no |  | Specialty required to perform the service (immutable after creation). |
| `name` | `text` | no |  |  |
| `duration_minutes` | `integer` | no |  | Slot length in minutes (5..480, multiple of 5). Changes affect future bookings only. |
| `status` | `text` | no | `'active'::text` |  |
| `version` | `integer` | no | `1` | Aggregate version carried in Service* events (replica ordering). |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `services_duration_range`: `CHECK ((((duration_minutes >= 5) AND (duration_minutes <= 480)) AND ((duration_minutes % 5) = 0)))`
- `services_name_length`: `CHECK (((char_length(btrim(name)) >= 2) AND (char_length(btrim(name)) <= 120)))`
- `services_pkey`: `PRIMARY KEY (id)`
- `services_specialty_fk`: `FOREIGN KEY (tenant_id, specialty_id) REFERENCES catalog.specialties(tenant_id, id)`
- `services_status`: `CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))`
- `services_tenant_id_fkey`: `FOREIGN KEY (tenant_id) REFERENCES catalog.tenants(id)`
- `services_tenant_id_unique`: `UNIQUE (tenant_id, id)`
- `services_version_positive`: `CHECK ((version >= 1))`

**Indexes**

- `services_name_unique`: `CREATE UNIQUE INDEX services_name_unique ON catalog.services USING btree (tenant_id, lower(name))` — SERVICE_NAME_TAKEN (case-insensitive, per tenant).
- `services_pkey`: `CREATE UNIQUE INDEX services_pkey ON catalog.services USING btree (id)`
- `services_tenant_id_unique`: `CREATE UNIQUE INDEX services_tenant_id_unique ON catalog.services USING btree (tenant_id, id)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


### `specialties`

Medical specialties of a clinic, required by services (RF3) and held by professionals (RF4).

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  |  |
| `tenant_id` | `uuid` | no |  |  |
| `name` | `text` | no |  |  |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `specialties_name_length`: `CHECK (((char_length(btrim(name)) >= 2) AND (char_length(btrim(name)) <= 80)))`
- `specialties_pkey`: `PRIMARY KEY (id)`
- `specialties_tenant_id_fkey`: `FOREIGN KEY (tenant_id) REFERENCES catalog.tenants(id)`
- `specialties_tenant_id_unique`: `UNIQUE (tenant_id, id)`

**Indexes**

- `specialties_name_unique`: `CREATE UNIQUE INDEX specialties_name_unique ON catalog.specialties USING btree (tenant_id, lower(name))` — SPECIALTY_NAME_TAKEN (case-insensitive, per tenant).
- `specialties_pkey`: `CREATE UNIQUE INDEX specialties_pkey ON catalog.specialties USING btree (id)`
- `specialties_tenant_id_unique`: `CREATE UNIQUE INDEX specialties_tenant_id_unique ON catalog.specialties USING btree (tenant_id, id)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


### `tenants`

Read replica of control-plane tenants (TenantOnboarded). FK target for tenant_id.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  |  |
| `slug` | `text` | no |  |  |
| `name` | `text` | no |  |  |
| `timezone` | `text` | no |  |  |
| `status` | `text` | no |  |  |
| `version` | `integer` | no |  |  |
| `replicated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `tenants_pkey`: `PRIMARY KEY (id)`
- `tenants_status`: `CHECK ((status = 'active'::text))`
- `tenants_version_positive`: `CHECK ((version >= 1))`

**Indexes**

- `tenants_pkey`: `CREATE UNIQUE INDEX tenants_pkey ON catalog.tenants USING btree (id)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


## scheduler-management — database `medicitas_scheduler`, schema `scheduling`

### `appointments`

Appointment aggregate (owner: scheduler-management). Active = held or booked; only active rows occupy the agenda (I1, I2, I7).

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  |  |
| `tenant_id` | `uuid` | no |  |  |
| `patient_id` | `uuid` | no |  | patients.id in user-management (logical reference validated by the booking saga). |
| `professional_id` | `uuid` | no |  |  |
| `service_id` | `uuid` | no |  |  |
| `slot` | `tstzrange` | no |  | Occupied interval [start, end); its length is the service duration at booking time (I4). Never updated in place. |
| `starts_at` | `timestamp with time zone` | yes | `lower(slot)` | Generated lower(slot). Exists because range functions/operators are not LEAKPROOF: under RLS they cannot be index conditions, while timestamptz comparisons can. |
| `ends_at` | `timestamp with time zone` | yes | `upper(slot)` | Generated upper(slot); see starts_at. |
| `status` | `text` | no |  | held (internal saga hold) → booked \| released; booked → attended \| no_show \| cancelled \| rescheduled (RF13). Final states have no exit. |
| `hold_expires_at` | `timestamp with time zone` | yes |  | Expiry of a held slot; the sweeper releases expired holds. |
| `release_reason_code` | `text` | yes |  | Why a hold was released (saga compensation or HOLD_EXPIRED). |
| `saga_id` | `uuid` | yes |  | Booking saga that created the row (NULL for reschedule successors and seeds). |
| `rescheduled_from_id` | `uuid` | yes |  | Previous appointment when this row is the result of a reschedule (RF10). |
| `booked_by_subject` | `uuid` | no |  | Keycloak subject of the user who booked or rescheduled. |
| `cancel_reason` | `text` | yes |  | Cancellation reason (RF11). |
| `cancelled_by_subject` | `uuid` | yes |  | User who cancelled (RF11). |
| `cancelled_at` | `timestamp with time zone` | yes |  |  |
| `outcome_recorded_by_subject` | `uuid` | yes |  | User who recorded attended/no_show (RF12). |
| `outcome_recorded_at` | `timestamp with time zone` | yes |  |  |
| `version` | `integer` | no | `1` |  |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `appointments_cancelled_consistency`: `CHECK ((((status = 'cancelled'::text) = (cancelled_at IS NOT NULL)) AND ((cancelled_at IS NULL) OR ((cancelled_by_subject IS NOT NULL) AND ((char_length(btrim(cancel_reason)) >= 1) AND (char_length(btrim(cancel_reason)) <= 500))))))`
- `appointments_held_has_expiry`: `CHECK (((status <> 'held'::text) OR (hold_expires_at IS NOT NULL)))`
- `appointments_no_patient_overlap`: `EXCLUDE USING gist (tenant_id WITH =, patient_id WITH =, slot WITH &&) WHERE ((status = ANY (ARRAY['held'::text, 'booked'::text])))`
- `appointments_no_professional_overlap`: `EXCLUDE USING gist (tenant_id WITH =, professional_id WITH =, slot WITH &&) WHERE ((status = ANY (ARRAY['held'::text, 'booked'::text])))`
- `appointments_outcome_consistency`: `CHECK ((((status = ANY (ARRAY['attended'::text, 'no_show'::text])) = (outcome_recorded_at IS NOT NULL)) AND ((outcome_recorded_at IS NULL) OR (outcome_recorded_by_subject IS NOT NULL))))`
- `appointments_pkey`: `PRIMARY KEY (id)`
- `appointments_professional_fk`: `FOREIGN KEY (tenant_id, professional_id) REFERENCES scheduling.catalog_professionals(tenant_id, id)`
- `appointments_released_has_reason`: `CHECK (((status = 'released'::text) = (release_reason_code IS NOT NULL)))`
- `appointments_rescheduled_from_fk`: `FOREIGN KEY (tenant_id, rescheduled_from_id) REFERENCES scheduling.appointments(tenant_id, id)`
- `appointments_service_fk`: `FOREIGN KEY (tenant_id, service_id) REFERENCES scheduling.catalog_services(tenant_id, id)`
- `appointments_slot_bounded`: `CHECK (((NOT isempty(slot)) AND (NOT lower_inf(slot)) AND (NOT upper_inf(slot)) AND lower_inc(slot) AND (NOT upper_inc(slot))))`
- `appointments_status`: `CHECK ((status = ANY (ARRAY['held'::text, 'released'::text, 'booked'::text, 'attended'::text, 'no_show'::text, 'cancelled'::text, 'rescheduled'::text])))`
- `appointments_tenant_id_fkey`: `FOREIGN KEY (tenant_id) REFERENCES scheduling.tenants(id)`
- `appointments_tenant_id_unique`: `UNIQUE (tenant_id, id)`
- `appointments_version_positive`: `CHECK ((version >= 1))`

**Indexes**

- `appointments_active_professional_start_idx`: `CREATE INDEX appointments_active_professional_start_idx ON scheduling.appointments USING btree (tenant_id, professional_id, starts_at) INCLUDE (ends_at) WHERE (status = ANY (ARRAY['held'::text, 'booked'::text]))` — RF7 (and booking checks): active appointments of one professional around a date; RLS-compatible (leakproof timestamptz operators).
- `appointments_held_expiry_idx`: `CREATE INDEX appointments_held_expiry_idx ON scheduling.appointments USING btree (hold_expires_at) WHERE (status = 'held'::text)` — Hold-expiry sweeper.
- `appointments_no_patient_overlap`: `CREATE INDEX appointments_no_patient_overlap ON scheduling.appointments USING gist (tenant_id, patient_id, slot) WHERE (status = ANY (ARRAY['held'::text, 'booked'::text]))`
- `appointments_no_professional_overlap`: `CREATE INDEX appointments_no_professional_overlap ON scheduling.appointments USING gist (tenant_id, professional_id, slot) WHERE (status = ANY (ARRAY['held'::text, 'booked'::text]))`
- `appointments_patient_history_idx`: `CREATE INDEX appointments_patient_history_idx ON scheduling.appointments USING btree (tenant_id, patient_id, starts_at DESC)` — RF16 patient history ordered by start descending.
- `appointments_pkey`: `CREATE UNIQUE INDEX appointments_pkey ON scheduling.appointments USING btree (id)`
- `appointments_rescheduled_from_unique`: `CREATE UNIQUE INDEX appointments_rescheduled_from_unique ON scheduling.appointments USING btree (tenant_id, rescheduled_from_id) WHERE (rescheduled_from_id IS NOT NULL)` — A rescheduled appointment has at most one successor.
- `appointments_tenant_id_unique`: `CREATE UNIQUE INDEX appointments_tenant_id_unique ON scheduling.appointments USING btree (tenant_id, id)`
- `appointments_tenant_start_idx`: `CREATE INDEX appointments_tenant_start_idx ON scheduling.appointments USING btree (tenant_id, starts_at) INCLUDE (status, professional_id)` — RF20 day agenda (clinic-wide) and RF21 status counts by date range.

**Row-Level Security**: enabled + forced — policies: `professional_outcome_only` (UPDATE, restrictive), `tenant_isolation` (ALL), `worker_discovery` (SELECT)


### `audit_log`

Append-only audit of every read/write of clinical notes and patient contact data (RF18): who, what, which patient, when. Never contains note text or contact values.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |  |
| `tenant_id` | `uuid` | no |  |  |
| `occurred_at` | `timestamp with time zone` | no |  | When the access happened (DB clock for notes; source event time for patient contact). |
| `recorded_at` | `timestamp with time zone` | no | `clock_timestamp()` | When the row was appended (database clock). |
| `actor_subject` | `uuid` | no |  | Keycloak subject of the user who accessed the data. |
| `actor_role` | `text` | no |  |  |
| `patient_id` | `uuid` | no |  | Patient whose data was accessed. |
| `resource_type` | `text` | no |  | clinical_note or patient_contact. |
| `resource_id` | `uuid` | no |  | Note id or patient id. |
| `action` | `text` | no |  |  |
| `outcome` | `text` | no |  | success, or denied for refused attempts. |
| `correlation_id` | `uuid` | no |  |  |
| `source_service` | `text` | no |  |  |
| `source_message_id` | `uuid` | yes |  | messageId of the PatientContactAccessed event (de-duplication); NULL for local note accesses. |

**Constraints**

- `audit_log_action`: `CHECK ((action = ANY (ARRAY['read'::text, 'create'::text, 'update'::text])))`
- `audit_log_actor_role`: `CHECK ((actor_role = ANY (ARRAY['clinic_admin'::text, 'receptionist'::text, 'health_professional'::text])))`
- `audit_log_occurred_not_after_recorded`: `CHECK ((occurred_at <= (recorded_at + '00:05:00'::interval)))`
- `audit_log_outcome`: `CHECK ((outcome = ANY (ARRAY['success'::text, 'denied'::text])))`
- `audit_log_pkey`: `PRIMARY KEY (id)`
- `audit_log_resource_type`: `CHECK ((resource_type = ANY (ARRAY['clinical_note'::text, 'patient_contact'::text])))`
- `audit_log_source_message_unique`: `UNIQUE (source_message_id)`
- `audit_log_source_service`: `CHECK ((source_service = ANY (ARRAY['scheduler-management'::text, 'user-management'::text])))`
- `audit_log_tenant_id_fkey`: `FOREIGN KEY (tenant_id) REFERENCES scheduling.tenants(id)`

**Indexes**

- `audit_log_pkey`: `CREATE UNIQUE INDEX audit_log_pkey ON scheduling.audit_log USING btree (id)`
- `audit_log_source_message_unique`: `CREATE UNIQUE INDEX audit_log_source_message_unique ON scheduling.audit_log USING btree (source_message_id)`
- `audit_log_tenant_actor_idx`: `CREATE INDEX audit_log_tenant_actor_idx ON scheduling.audit_log USING btree (tenant_id, actor_subject, occurred_at DESC)` — RF19 user filter.
- `audit_log_tenant_patient_idx`: `CREATE INDEX audit_log_tenant_patient_idx ON scheduling.audit_log USING btree (tenant_id, patient_id, occurred_at DESC)` — RF19 patient filter.
- `audit_log_tenant_time_idx`: `CREATE INDEX audit_log_tenant_time_idx ON scheduling.audit_log USING btree (tenant_id, occurred_at DESC, id)` — RF19 date-range filter, newest first.

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


### `availability_versions`

Monotonic version per (professional, local date), bumped in the same transaction as any change affecting availability. Absent row = version 0. Part of the Redis key (I8).

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `tenant_id` | `uuid` | no |  |  |
| `professional_id` | `uuid` | no |  |  |
| `local_date` | `date` | no |  |  |
| `version` | `bigint` | no | `1` |  |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `availability_versions_agenda_fk`: `FOREIGN KEY (tenant_id, professional_id) REFERENCES scheduling.professional_agendas(tenant_id, professional_id)`
- `availability_versions_pk`: `PRIMARY KEY (tenant_id, professional_id, local_date)`
- `availability_versions_positive`: `CHECK ((version >= 1))`

**Indexes**

- `availability_versions_pk`: `CREATE UNIQUE INDEX availability_versions_pk ON scheduling.availability_versions USING btree (tenant_id, professional_id, local_date)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


### `calendar_blocks`

Agenda blocks for vacations or leave (RF6). They remove availability going forward but never cancel booked appointments (listed as conflicts).

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |  |
| `tenant_id` | `uuid` | no |  |  |
| `professional_id` | `uuid` | no |  |  |
| `period` | `tstzrange` | no |  | Blocked interval [start, end) in absolute time. |
| `reason` | `text` | no |  |  |
| `note` | `text` | yes |  |  |
| `status` | `text` | no | `'active'::text` | active, or removed (logical removal restores availability). |
| `created_by_subject` | `uuid` | no |  |  |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `removed_by_subject` | `uuid` | yes |  |  |
| `removed_at` | `timestamp with time zone` | yes |  |  |

**Constraints**

- `calendar_blocks_agenda_fk`: `FOREIGN KEY (tenant_id, professional_id) REFERENCES scheduling.professional_agendas(tenant_id, professional_id)`
- `calendar_blocks_note_length`: `CHECK (((note IS NULL) OR (char_length(note) <= 200)))`
- `calendar_blocks_period_bounded`: `CHECK (((NOT isempty(period)) AND (NOT lower_inf(period)) AND (NOT upper_inf(period)) AND lower_inc(period) AND (NOT upper_inc(period))))`
- `calendar_blocks_period_max_span`: `CHECK (((upper(period) - lower(period)) <= '90 days'::interval))`
- `calendar_blocks_pkey`: `PRIMARY KEY (id)`
- `calendar_blocks_reason`: `CHECK ((reason = ANY (ARRAY['vacation'::text, 'leave'::text, 'other'::text])))`
- `calendar_blocks_removed_consistency`: `CHECK (((status = 'removed'::text) = ((removed_at IS NOT NULL) AND (removed_by_subject IS NOT NULL))))`
- `calendar_blocks_status`: `CHECK ((status = ANY (ARRAY['active'::text, 'removed'::text])))`
- `calendar_blocks_tenant_id_unique`: `UNIQUE (tenant_id, id)`

**Indexes**

- `calendar_blocks_active_period_idx`: `CREATE INDEX calendar_blocks_active_period_idx ON scheduling.calendar_blocks USING gist (tenant_id, professional_id, period) WHERE (status = 'active'::text)` — RF7/I3: active blocks overlapping a day or a slot for one professional.
- `calendar_blocks_pkey`: `CREATE UNIQUE INDEX calendar_blocks_pkey ON scheduling.calendar_blocks USING btree (id)`
- `calendar_blocks_tenant_id_unique`: `CREATE UNIQUE INDEX calendar_blocks_tenant_id_unique ON scheduling.calendar_blocks USING btree (tenant_id, id)`

**Row-Level Security**: enabled + forced — policies: `own_blocks_insert` (INSERT, restrictive), `own_blocks_update` (UPDATE, restrictive), `tenant_isolation` (ALL)


### `catalog_professional_services`

Replica of the professional–service association set (full set replaced per event).

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `tenant_id` | `uuid` | no |  |  |
| `professional_id` | `uuid` | no |  |  |
| `service_id` | `uuid` | no |  |  |

**Constraints**

- `catalog_professional_services_pk`: `PRIMARY KEY (tenant_id, professional_id, service_id)`
- `catalog_professional_services_professional_fk`: `FOREIGN KEY (tenant_id, professional_id) REFERENCES scheduling.catalog_professionals(tenant_id, id)`
- `catalog_professional_services_service_fk`: `FOREIGN KEY (tenant_id, service_id) REFERENCES scheduling.catalog_services(tenant_id, id)`

**Indexes**

- `catalog_professional_services_pk`: `CREATE UNIQUE INDEX catalog_professional_services_pk ON scheduling.catalog_professional_services USING btree (tenant_id, professional_id, service_id)`
- `catalog_professional_services_service_idx`: `CREATE INDEX catalog_professional_services_service_idx ON scheduling.catalog_professional_services USING btree (tenant_id, service_id)` — RF8: professionals offering a service.

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


### `catalog_professionals`

Replica of catalog professionals (Professional* events). keycloak_subject resolves "own" rules (schedule:manage-own, agenda:read-own, RF15).

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  |  |
| `tenant_id` | `uuid` | no |  |  |
| `user_id` | `uuid` | no |  |  |
| `keycloak_subject` | `uuid` | no |  |  |
| `display_name` | `text` | no |  |  |
| `specialty_id` | `uuid` | no |  |  |
| `status` | `text` | no |  |  |
| `version` | `integer` | no |  |  |
| `services_version` | `integer` | no |  | Version of the replicated association set (ProfessionalServicesChanged). |
| `replicated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `catalog_professionals_pk`: `PRIMARY KEY (id)`
- `catalog_professionals_status`: `CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))`
- `catalog_professionals_subject_unique`: `UNIQUE (keycloak_subject)`
- `catalog_professionals_tenant_id_fkey`: `FOREIGN KEY (tenant_id) REFERENCES scheduling.tenants(id)`
- `catalog_professionals_tenant_id_unique`: `UNIQUE (tenant_id, id)`
- `catalog_professionals_versions_positive`: `CHECK (((version >= 1) AND (services_version >= 1)))`

**Indexes**

- `catalog_professionals_pk`: `CREATE UNIQUE INDEX catalog_professionals_pk ON scheduling.catalog_professionals USING btree (id)`
- `catalog_professionals_subject_unique`: `CREATE UNIQUE INDEX catalog_professionals_subject_unique ON scheduling.catalog_professionals USING btree (keycloak_subject)`
- `catalog_professionals_tenant_id_unique`: `CREATE UNIQUE INDEX catalog_professionals_tenant_id_unique ON scheduling.catalog_professionals USING btree (tenant_id, id)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


### `catalog_services`

Replica of catalog services (Service* events): duration and status drive slot length (I4).

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  |  |
| `tenant_id` | `uuid` | no |  |  |
| `specialty_id` | `uuid` | no |  |  |
| `name` | `text` | no |  |  |
| `duration_minutes` | `integer` | no |  |  |
| `status` | `text` | no |  |  |
| `version` | `integer` | no |  | Catalog aggregate version; an event is applied only if newer. |
| `replicated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `catalog_services_duration_range`: `CHECK ((((duration_minutes >= 5) AND (duration_minutes <= 480)) AND ((duration_minutes % 5) = 0)))`
- `catalog_services_pk`: `PRIMARY KEY (id)`
- `catalog_services_status`: `CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))`
- `catalog_services_tenant_id_fkey`: `FOREIGN KEY (tenant_id) REFERENCES scheduling.tenants(id)`
- `catalog_services_tenant_id_unique`: `UNIQUE (tenant_id, id)`
- `catalog_services_version_positive`: `CHECK ((version >= 1))`

**Indexes**

- `catalog_services_pk`: `CREATE UNIQUE INDEX catalog_services_pk ON scheduling.catalog_services USING btree (id)`
- `catalog_services_tenant_id_unique`: `CREATE UNIQUE INDEX catalog_services_tenant_id_unique ON scheduling.catalog_services USING btree (tenant_id, id)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


### `clinical_notes`

Clinical note of an attended appointment (RF15): the most sensitive data. Written only by the appointment professional; immutable; every read/write is audited.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  |  |
| `tenant_id` | `uuid` | no |  |  |
| `appointment_id` | `uuid` | no |  |  |
| `author_subject` | `uuid` | no |  | Keycloak subject of the authoring professional (must be the appointment professional). |
| `content` | `text` | no |  | Free-text note. Never copied to events, logs or the audit log. |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `clinical_notes_appointment_fk`: `FOREIGN KEY (tenant_id, appointment_id) REFERENCES scheduling.appointments(tenant_id, id)`
- `clinical_notes_appointment_unique`: `UNIQUE (tenant_id, appointment_id)`
- `clinical_notes_content_length`: `CHECK (((char_length(btrim(content)) >= 1) AND (char_length(btrim(content)) <= 20000)))`
- `clinical_notes_pkey`: `PRIMARY KEY (id)`

**Indexes**

- `clinical_notes_appointment_unique`: `CREATE UNIQUE INDEX clinical_notes_appointment_unique ON scheduling.clinical_notes USING btree (tenant_id, appointment_id)`
- `clinical_notes_pkey`: `CREATE UNIQUE INDEX clinical_notes_pkey ON scheduling.clinical_notes USING btree (id)`

**Row-Level Security**: enabled + forced — policies: `own_notes` (ALL, restrictive), `tenant_isolation` (ALL)


### `professional_agendas`

Lock anchor of a professional agenda: bookings take FOR SHARE, schedule/block writers take FOR UPDATE. schedule_version is part of the availability cache key.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `tenant_id` | `uuid` | no |  |  |
| `professional_id` | `uuid` | no |  |  |
| `schedule_version` | `bigint` | no | `0` | Bumped on weekly schedule changes and professional status changes. |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `professional_agendas_pk`: `PRIMARY KEY (tenant_id, professional_id)`
- `professional_agendas_professional_fk`: `FOREIGN KEY (tenant_id, professional_id) REFERENCES scheduling.catalog_professionals(tenant_id, id)`
- `professional_agendas_version_non_negative`: `CHECK ((schedule_version >= 0))`

**Indexes**

- `professional_agendas_pk`: `CREATE UNIQUE INDEX professional_agendas_pk ON scheduling.professional_agendas USING btree (tenant_id, professional_id)`

**Row-Level Security**: enabled + forced — policies: `own_agenda_update` (UPDATE, restrictive), `tenant_isolation` (ALL)


### `scheduling_settings`

Single-row scheduling parameters shared by the database rules and the service.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `singleton` | `boolean` | no | `true` |  |
| `slot_step_minutes` | `integer` | no | `15` | Slot grid step, anchored at each weekly block start. |
| `booking_horizon_days` | `integer` | no | `180` | Maximum days ahead for availability queries and bookings. |
| `hold_ttl_seconds` | `integer` | no | `60` | Lifetime of a held slot before the sweeper releases it. |

**Constraints**

- `scheduling_settings_hold_ttl`: `CHECK (((hold_ttl_seconds >= 10) AND (hold_ttl_seconds <= 600)))`
- `scheduling_settings_horizon`: `CHECK (((booking_horizon_days >= 1) AND (booking_horizon_days <= 730)))`
- `scheduling_settings_pkey`: `PRIMARY KEY (singleton)`
- `scheduling_settings_singleton`: `CHECK (singleton)`
- `scheduling_settings_step`: `CHECK ((slot_step_minutes = ANY (ARRAY[5, 10, 15, 20, 30, 60])))`

**Indexes**

- `scheduling_settings_pkey`: `CREATE UNIQUE INDEX scheduling_settings_pkey ON scheduling.scheduling_settings USING btree (singleton)`

**Row-Level Security**: not enabled (control-plane or reference table)


### `tenants`

Replica of control-plane tenants (TenantOnboarded). Source of the clinic timezone for local dates and working hours.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  |  |
| `slug` | `text` | no |  |  |
| `name` | `text` | no |  |  |
| `timezone` | `text` | no |  | IANA timezone used to interpret weekly schedules and local dates. |
| `status` | `text` | no |  |  |
| `version` | `integer` | no |  |  |
| `replicated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `tenants_pkey`: `PRIMARY KEY (id)`
- `tenants_status`: `CHECK ((status = 'active'::text))`
- `tenants_version_positive`: `CHECK ((version >= 1))`

**Indexes**

- `tenants_pkey`: `CREATE UNIQUE INDEX tenants_pkey ON scheduling.tenants USING btree (id)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL)


### `weekly_schedule_blocks`

Weekly working hours (RF5): several blocks per day allowed (split shifts). Times are local to the tenant timezone. A schedule is replaced as a whole set.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |  |
| `tenant_id` | `uuid` | no |  |  |
| `professional_id` | `uuid` | no |  |  |
| `day_of_week` | `smallint` | no |  | ISO weekday: 1 = Monday … 7 = Sunday. |
| `start_time` | `time without time zone` | no |  | Local start time (inclusive). |
| `end_time` | `time without time zone` | no |  | Local end time (exclusive); 24:00 allowed. |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `weekly_schedule_blocks_agenda_fk`: `FOREIGN KEY (tenant_id, professional_id) REFERENCES scheduling.professional_agendas(tenant_id, professional_id)`
- `weekly_schedule_blocks_day`: `CHECK (((day_of_week >= 1) AND (day_of_week <= 7)))`
- `weekly_schedule_blocks_grid`: `CHECK (((EXTRACT(second FROM start_time) = (0)::numeric) AND (EXTRACT(second FROM end_time) = (0)::numeric) AND (((EXTRACT(minute FROM start_time))::integer % 5) = 0) AND (((EXTRACT(minute FROM end_time))::integer % 5) = 0)))`
- `weekly_schedule_blocks_no_overlap`: `EXCLUDE USING gist (tenant_id WITH =, professional_id WITH =, day_of_week WITH =, tsrange(('2000-01-03'::date + start_time), ('2000-01-03'::date + end_time), '[)'::text) WITH &&)`
- `weekly_schedule_blocks_order`: `CHECK (((start_time < end_time) OR (end_time = '24:00:00'::time without time zone)))`
- `weekly_schedule_blocks_pkey`: `PRIMARY KEY (id)`

**Indexes**

- `weekly_schedule_blocks_no_overlap`: `CREATE INDEX weekly_schedule_blocks_no_overlap ON scheduling.weekly_schedule_blocks USING gist (tenant_id, professional_id, day_of_week, tsrange(('2000-01-03'::date + start_time), ('2000-01-03'::date + end_time), '[)'::text))`
- `weekly_schedule_blocks_pkey`: `CREATE UNIQUE INDEX weekly_schedule_blocks_pkey ON scheduling.weekly_schedule_blocks USING btree (id)`

**Row-Level Security**: enabled + forced — policies: `own_schedule_delete` (DELETE, restrictive), `own_schedule_insert` (INSERT, restrictive), `tenant_isolation` (ALL)


## appointment-orchestrator — database `medicitas_appointment_orchestrator`, schema `booking`

### `saga_instances`

Booking sagas (RF9). Identifiers (appointment, new patient) are generated before dispatch so every participant is idempotent by id. New-patient PII is not stored here (it travels only in the EnsurePatientCommand outbox row).

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `id` | `uuid` | no |  | Saga identifier; also the public operationId. |
| `tenant_id` | `uuid` | no |  |  |
| `saga_type` | `text` | no | `'appointment-booking'::text` |  |
| `appointment_id` | `uuid` | no |  | Appointment id pre-generated for HoldSlotCommand. |
| `patient_id` | `uuid` | no |  | Existing patient id, or the id pre-generated for a new patient. |
| `professional_id` | `uuid` | no |  |  |
| `service_id` | `uuid` | no |  |  |
| `start_at` | `timestamp with time zone` | no |  | Requested start instant; the end is derived by the scheduler from the service duration (I4). |
| `patient_mode` | `text` | no |  | existing: validate; create: register in the same operation. |
| `status` | `text` | no | `'started'::text` | started → awaiting_participants → confirming → completed \| compensating → failed. |
| `result` | `jsonb` | yes |  | Confirmed appointment returned by the operation resource. |
| `error_code` | `text` | yes |  | Most specific business error (SLOT_TAKEN > PATIENT_OVERLAP > validation > not found > dependency). |
| `error_detail` | `text` | yes |  |  |
| `actor_subject` | `uuid` | no |  |  |
| `correlation_id` | `uuid` | no |  |  |
| `deadline_at` | `timestamp with time zone` | no |  | After this instant the saga compensates (default 15 s). |
| `version` | `integer` | no | `1` |  |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `completed_at` | `timestamp with time zone` | yes |  |  |
| `actor_role` | `text` | no |  | MediCitas role of the user who requested the booking; copied into every command envelope of the saga. |

**Constraints**

- `saga_instances_actor_role`: `CHECK ((actor_role = ANY (ARRAY['clinic_admin'::text, 'receptionist'::text])))`
- `saga_instances_appointment_unique`: `UNIQUE (tenant_id, appointment_id)`
- `saga_instances_failed_has_error`: `CHECK (((status <> 'failed'::text) OR (error_code IS NOT NULL)))`
- `saga_instances_patient_mode`: `CHECK ((patient_mode = ANY (ARRAY['existing'::text, 'create'::text])))`
- `saga_instances_pkey`: `PRIMARY KEY (id)`
- `saga_instances_status`: `CHECK ((status = ANY (ARRAY['started'::text, 'awaiting_participants'::text, 'confirming'::text, 'completed'::text, 'compensating'::text, 'failed'::text])))`
- `saga_instances_tenant_id_unique`: `UNIQUE (tenant_id, id)`
- `saga_instances_terminal_completed_at`: `CHECK (((status = ANY (ARRAY['completed'::text, 'failed'::text])) = (completed_at IS NOT NULL)))`
- `saga_instances_type`: `CHECK ((saga_type = 'appointment-booking'::text))`

**Indexes**

- `saga_instances_appointment_unique`: `CREATE UNIQUE INDEX saga_instances_appointment_unique ON booking.saga_instances USING btree (tenant_id, appointment_id)`
- `saga_instances_open_deadline_idx`: `CREATE INDEX saga_instances_open_deadline_idx ON booking.saga_instances USING btree (deadline_at) WHERE (status <> ALL (ARRAY['completed'::text, 'failed'::text]))` — Sweeper: non-terminal sagas by deadline.
- `saga_instances_pkey`: `CREATE UNIQUE INDEX saga_instances_pkey ON booking.saga_instances USING btree (id)`
- `saga_instances_tenant_id_unique`: `CREATE UNIQUE INDEX saga_instances_tenant_id_unique ON booking.saga_instances USING btree (tenant_id, id)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL), `worker_discovery` (SELECT)


### `saga_steps`

Booking saga steps: patient, catalog and slot run in parallel; confirm or release follow.

| Column | Type | Null | Default | Description |
|---|---|:-:|---|---|
| `tenant_id` | `uuid` | no |  |  |
| `saga_id` | `uuid` | no |  |  |
| `step_name` | `text` | no |  |  |
| `status` | `text` | no | `'pending'::text` |  |
| `command_message_id` | `uuid` | yes |  | messageId of the command (outbox id), re-sent unchanged by the sweeper. |
| `attempts` | `integer` | no | `0` |  |
| `last_attempt_at` | `timestamp with time zone` | yes |  |  |
| `next_attempt_at` | `timestamp with time zone` | yes |  |  |
| `result` | `jsonb` | yes |  | Persisted reply result (e.g. durationMinutes and serviceVersion from catalog and slot). |
| `error_code` | `text` | yes |  |  |
| `created_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |
| `updated_at` | `timestamp with time zone` | no | `clock_timestamp()` |  |

**Constraints**

- `saga_steps_attempts_non_negative`: `CHECK ((attempts >= 0))`
- `saga_steps_name`: `CHECK ((step_name = ANY (ARRAY['patient'::text, 'catalog'::text, 'slot'::text, 'confirm'::text, 'release'::text])))`
- `saga_steps_pk`: `PRIMARY KEY (saga_id, step_name)`
- `saga_steps_saga_fk`: `FOREIGN KEY (tenant_id, saga_id) REFERENCES booking.saga_instances(tenant_id, id)`
- `saga_steps_status`: `CHECK ((status = ANY (ARRAY['pending'::text, 'dispatched'::text, 'succeeded'::text, 'rejected'::text, 'failed'::text, 'compensating'::text, 'compensated'::text, 'skipped'::text])))`

**Indexes**

- `saga_steps_pk`: `CREATE UNIQUE INDEX saga_steps_pk ON booking.saga_steps USING btree (saga_id, step_name)`

**Row-Level Security**: enabled + forced — policies: `tenant_isolation` (ALL), `worker_discovery` (SELECT)

