import type { DatabaseClient } from '@medicitas/kernel';
import type { EphemeralSecrets, KeycloakAdminClient } from '@medicitas/identity';
import type { Logger } from '@medicitas/observability';
import { PermanentStepError, dispatchSagaCommand, type PgSagaStore, type SagaHooks, type SagaRecord } from '@medicitas/runtime';
import { COMMANDS, nextStep, type CommandStep, type OnboardingRequest } from '../domain/onboarding.js';

export interface OnboardingSettings {
  readonly resendMs: number;
  readonly convergeWindowMs: number;
  readonly compensationWindowMs: number;
}

const PRODUCER = 'onboarding-orchestrator';
const TENANTS_GROUP = '/tenants';

/**
 * Sends a command to tenant-management. The outbox row carries the tenant of the envelope, so the
 * transaction-local app.tenant_id is aligned with it first (control-plane tables have no tenant RLS;
 * the outbox policy still requires the match).
 */
export async function sendCommand(
  client: DatabaseClient,
  store: PgSagaStore,
  saga: Pick<SagaRecord, 'id' | 'tenantId' | 'actorSubject' | 'correlationId'>,
  step: CommandStep,
  payload: Readonly<Record<string, unknown>>,
  settings: OnboardingSettings,
  insertOnly = false,
): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [saga.tenantId ?? '']);
  await dispatchSagaCommand(client, store, {
    producer: PRODUCER,
    saga,
    actorRole: 'platform_admin',
    step,
    ...COMMANDS[step],
    payload,
    resendMs: settings.resendMs,
    insertOnly,
  });
}

/** → COMPENSATING: delete what THIS saga created in Keycloak (P5) and mark the tenant failed (row kept). */
async function compensate(client: DatabaseClient, store: PgSagaStore, saga: SagaRecord, errorCode: string, settings: OnboardingSettings): Promise<void> {
  for (const step of await store.steps(saga.id)) {
    if ((step.name === 'keycloak_group' || step.name === 'keycloak_admin_user') && (step.status === 'pending' || step.status === 'dispatched')) {
      await store.setStep(saga.id, step.name, { status: 'skipped', nextAttemptMs: null });
    }
  }
  await store.setStep(saga.id, 'delete_keycloak_user', { status: 'pending', nextAttemptMs: 0 });
  await store.setStep(saga.id, 'delete_keycloak_group', { status: 'pending', nextAttemptMs: 0 });
  if (saga.tenantId !== null) {
    await sendCommand(client, store, saga, 'mark_tenant_failed', { tenantId: saga.tenantId, reasonCode: errorCode }, settings);
  }
  await store.update(saga.id, { status: 'compensating', errorCode, errorDetail: null, deadlineMs: settings.compensationWindowMs });
}

export function onboardingHooks(keycloak: KeycloakAdminClient, secrets: EphemeralSecrets, settings: OnboardingSettings, logger: Logger): SagaHooks {
  const owned = (attributes: Readonly<Record<string, readonly string[]>> | undefined, sagaId: string): boolean =>
    attributes?.['medicitas_saga_id']?.includes(sagaId) === true;
  const groupPath = (saga: SagaRecord): string => `${TENANTS_GROUP}/${(saga.request as unknown as OnboardingRequest).slug}`;

  return {
    localSteps: {
      /** Group /tenants/<slug> with the tenant_id attribute (organizational; idempotent by path). */
      async keycloak_group(saga) {
        const tenantId = saga.tenantId as string;
        let group = await keycloak.groupByPath(groupPath(saga));
        if (group === null) {
          const parent = await keycloak.groupByPath(TENANTS_GROUP);
          if (parent === null) throw new PermanentStepError('IDENTITY_PROVIDER_MISCONFIGURED', 'the /tenants group is missing');
          const created = await keycloak.createChildGroup(parent.id, (saga.request as unknown as OnboardingRequest).slug, {
            tenant_id: [tenantId],
            medicitas_saga_id: [saga.id],
          });
          group = created === null ? await keycloak.groupByPath(groupPath(saga)) : { id: created, name: '', attributes: { tenant_id: [tenantId], medicitas_saga_id: [saga.id] } };
        }
        if (group === null || group.attributes?.['tenant_id']?.includes(tenantId) !== true) {
          throw new PermanentStepError('TENANT_SLUG_TAKEN', 'the tenant group already belongs to another tenant');
        }
        return { groupId: group.id };
      },

      /** First clinic admin: tenant_id attribute, clinic_admin role, group membership, temporary password. */
      async keycloak_admin_user(saga, steps) {
        const request = saga.request as unknown as OnboardingRequest;
        const tenantId = saga.tenantId as string;
        let user = await keycloak.findUserByUsername(request.firstAdmin.email);
        if (user !== null && !owned(user.attributes, saga.id)) throw new PermanentStepError('EMAIL_TAKEN', 'the e-mail already has an identity');
        if (user === null) {
          const password = secrets.get(saga.id);
          if (password === undefined) throw new PermanentStepError('PROVISIONING_INTERRUPTED', 'the temporary password is no longer available');
          const created = await keycloak.createUser({
            username: request.firstAdmin.email,
            firstName: request.firstAdmin.firstName,
            lastName: request.firstAdmin.lastName,
            attributes: { tenant_id: [tenantId], medicitas_saga_id: [saga.id] },
            temporaryPassword: password,
          });
          user = created === null ? await keycloak.findUserByUsername(request.firstAdmin.email) : await keycloak.getUser(created);
          if (user === null || !owned(user.attributes, saga.id)) throw new PermanentStepError('EMAIL_TAKEN', 'the e-mail already has an identity');
        }
        await keycloak.addRealmRole(user.id, 'clinic_admin');
        const groupId = steps.find((step) => step.name === 'keycloak_group')?.result?.['groupId'];
        if (typeof groupId === 'string') await keycloak.addUserToGroup(user.id, groupId);
        secrets.delete(saga.id);
        return { keycloakSubject: user.id };
      },

      async delete_keycloak_user(saga) {
        secrets.delete(saga.id);
        const user = await keycloak.findUserByUsername((saga.request as unknown as OnboardingRequest).firstAdmin.email);
        if (user === null || !owned(user.attributes, saga.id)) return { deleted: false };
        await keycloak.deleteUser(user.id);
        return { deleted: true };
      },

      async delete_keycloak_group(saga) {
        const group = await keycloak.groupByPath(groupPath(saga));
        if (group === null || !owned(group.attributes, saga.id)) return { deleted: false };
        await keycloak.deleteGroup(group.id);
        return { deleted: true };
      },
    },

    async advance(client, store, saga) {
      if (saga.status === 'completed' || saga.status === 'failed') return;
      const next = nextStep(saga, await store.steps(saga.id));
      switch (next.kind) {
        case 'wait':
          return;
        case 'local':
          await store.setStep(saga.id, next.step, { status: 'pending', nextAttemptMs: 0 });
          await store.update(saga.id, { status: next.status, ...(next.tenantId === undefined ? {} : { tenantId: next.tenantId }) });
          return;
        case 'command':
          await sendCommand(client, store, saga, next.step, next.payload, settings);
          await store.update(saga.id, { status: next.status });
          return;
        case 'compensate':
          logger.warn({ sagaId: saga.id, code: next.errorCode }, 'onboarding saga compensating');
          await compensate(client, store, saga, next.errorCode, settings);
          return;
        case 'complete':
          await store.update(saga.id, { status: 'completed', result: next.result });
          logger.info({ sagaId: saga.id, tenantId: saga.tenantId }, 'onboarding saga completed');
          return;
        case 'fail':
          secrets.delete(saga.id);
          await store.update(saga.id, { status: 'failed', errorCode: next.errorCode, errorDetail: `Onboarding failed: ${next.errorCode}.` });
          logger.info({ sagaId: saga.id, code: next.errorCode }, 'onboarding saga failed');
          return;
      }
    },

    async onDeadline(client, store, saga) {
      if (saga.status === 'compensating') {
        await store.update(saga.id, { status: 'failed', errorCode: saga.errorCode ?? 'DEPENDENCY_UNAVAILABLE', errorDetail: 'Compensation window elapsed.' });
        return;
      }
      if (saga.status === 'activating') {
        // Point of no return: activation is retried (same messageId) until it succeeds, never compensated.
        await store.update(saga.id, { status: saga.status, deadlineMs: settings.convergeWindowMs });
        return;
      }
      if (saga.status === 'started') {
        // No answer from tenant-management: a late TenantCreatedReply is compensated by the reply handler.
        secrets.delete(saga.id);
        await store.update(saga.id, { status: 'failed', errorCode: 'DEPENDENCY_UNAVAILABLE', errorDetail: 'tenant-management did not answer in time.' });
        return;
      }
      await compensate(client, store, saga, 'DEPENDENCY_UNAVAILABLE', settings);
    },
  };
}
