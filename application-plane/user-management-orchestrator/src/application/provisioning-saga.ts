import type { DatabaseClient } from '@medicitas/kernel';
import type { EphemeralSecrets, KeycloakAdminClient } from '@medicitas/identity';
import type { Logger } from '@medicitas/observability';
import { PermanentStepError, dispatchSagaCommand, type PgSagaStore, type SagaHooks, type SagaRecord, type SagaStepRecord } from '@medicitas/runtime';
import { CLINIC_ROLES, COMMANDS, nextStep, type CommandStep, type CreationRequest } from '../domain/provisioning.js';

export interface ProvisioningSettings {
  readonly resendMs: number;
  /** Extension granted to sagas that must converge instead of compensating (Keycloak role/disable). */
  readonly convergeWindowMs: number;
  readonly compensationWindowMs: number;
}

const PRODUCER = 'user-management-orchestrator';

export async function sendCommand(
  client: DatabaseClient,
  store: PgSagaStore,
  saga: Pick<SagaRecord, 'id' | 'tenantId' | 'actorSubject' | 'correlationId'>,
  step: CommandStep,
  payload: Readonly<Record<string, unknown>>,
  settings: ProvisioningSettings,
  insertOnly = false,
): Promise<void> {
  await dispatchSagaCommand(client, store, {
    producer: PRODUCER,
    saga,
    actorRole: 'clinic_admin',
    step,
    ...COMMANDS[step],
    payload,
    resendMs: settings.resendMs,
    insertOnly,
  });
}

function targetUserId(saga: SagaRecord): string {
  return String(saga.request['userId']);
}

/** → COMPENSATING: delete the Keycloak user only if THIS saga created it, cancel the reservation. */
async function compensate(client: DatabaseClient, store: PgSagaStore, saga: SagaRecord, errorCode: string, settings: ProvisioningSettings): Promise<void> {
  const identity = (await store.steps(saga.id)).find((step) => step.name === 'keycloak_user');
  if (identity !== undefined && (identity.status === 'pending' || identity.status === 'dispatched')) {
    await store.setStep(saga.id, 'keycloak_user', { status: 'skipped', nextAttemptMs: null });
  }
  await store.setStep(saga.id, 'delete_keycloak_user', { status: 'pending', nextAttemptMs: 0 });
  await sendCommand(client, store, saga, 'cancel_reservation', { userId: targetUserId(saga), reasonCode: errorCode }, settings);
  await store.update(saga.id, { status: 'compensating', errorCode, errorDetail: null, deadlineMs: settings.compensationWindowMs });
}

export function provisioningHooks(
  keycloak: KeycloakAdminClient,
  secrets: EphemeralSecrets,
  settings: ProvisioningSettings,
  logger: Logger,
): SagaHooks {
  const subjectFrom = (steps: readonly SagaStepRecord[], name: string): string => {
    const subject = steps.find((step) => step.name === name)?.result?.['keycloakSubject'];
    if (typeof subject !== 'string') throw new PermanentStepError('IDENTITY_MISSING', 'the user has no Keycloak identity');
    return subject;
  };

  return {
    localSteps: {
      /** Idempotent by lookup (username = e-mail); a user created by another saga is a genuine conflict. */
      async keycloak_user(saga) {
        const request = saga.request as unknown as CreationRequest;
        const tenantId = saga.tenantId as string;
        const owned = (attributes: Readonly<Record<string, readonly string[]>> | undefined): boolean =>
          attributes?.['medicitas_saga_id']?.includes(saga.id) === true;
        let user = await keycloak.findUserByUsername(request.email);
        if (user !== null && !owned(user.attributes)) throw new PermanentStepError('EMAIL_TAKEN', 'the e-mail already has an identity');
        if (user === null) {
          const password = secrets.get(saga.id);
          if (password === undefined) {
            throw new PermanentStepError('PROVISIONING_INTERRUPTED', 'the temporary password is no longer available');
          }
          const created = await keycloak.createUser({
            username: request.email,
            firstName: request.firstName,
            lastName: request.lastName,
            attributes: { tenant_id: [tenantId], medicitas_saga_id: [saga.id] },
            temporaryPassword: password,
          });
          user = created === null ? await keycloak.findUserByUsername(request.email) : await keycloak.getUser(created);
          if (user === null || !owned(user.attributes)) throw new PermanentStepError('EMAIL_TAKEN', 'the e-mail already has an identity');
        }
        await keycloak.addRealmRole(user.id, request.role);
        // Organizational only: authorization relies on the tenant_id claim, not on groups.
        const group = (await keycloak.groupsByAttribute('tenant_id', tenantId))[0];
        if (group !== undefined) await keycloak.addUserToGroup(user.id, group.id);
        secrets.delete(saga.id);
        return { keycloakSubject: user.id, createdBySaga: true };
      },

      /** Compensation: deletes the identity only if it carries this saga's marker. */
      async delete_keycloak_user(saga) {
        const request = saga.request as unknown as CreationRequest;
        secrets.delete(saga.id);
        const user = await keycloak.findUserByUsername(request.email);
        if (user === null || user.attributes?.['medicitas_saga_id']?.includes(saga.id) !== true) return { deleted: false };
        await keycloak.deleteUser(user.id);
        return { deleted: true };
      },

      /** Single role per user: remove every other MediCitas clinical role, then add the new one. */
      async keycloak_role(saga, steps) {
        const subject = subjectFrom(steps, 'change_role');
        const role = String(saga.request['role']);
        for (const current of await keycloak.realmRolesOf(subject)) {
          if ((CLINIC_ROLES as readonly string[]).includes(current) && current !== role) await keycloak.removeRealmRole(subject, current);
        }
        await keycloak.addRealmRole(subject, role);
        return { role };
      },

      /** Logical delete must converge: disable the identity and revoke its sessions. */
      async keycloak_disable(_saga, steps) {
        const subject = subjectFrom(steps, 'deactivate_user');
        await keycloak.setEnabled(subject, false);
        await keycloak.logout(subject);
        return { disabled: true };
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
          await store.update(saga.id, { status: next.status });
          return;
        case 'command':
          await sendCommand(client, store, saga, next.step, next.payload, settings);
          await store.update(saga.id, { status: next.status });
          return;
        case 'compensate':
          await compensate(client, store, saga, next.errorCode, settings);
          return;
        case 'complete':
          await store.update(saga.id, { status: 'completed', result: next.result });
          logger.info({ sagaId: saga.id, sagaType: saga.sagaType }, 'provisioning saga completed');
          return;
        case 'fail':
          secrets.delete(saga.id);
          await store.update(saga.id, { status: 'failed', errorCode: next.errorCode, errorDetail: `Provisioning failed: ${next.errorCode}.` });
          logger.info({ sagaId: saga.id, code: next.errorCode }, 'provisioning saga failed');
          return;
      }
    },

    async onDeadline(client, store, saga) {
      if (saga.status === 'compensating') {
        await store.update(saga.id, { status: 'failed', errorCode: saga.errorCode ?? 'DEPENDENCY_UNAVAILABLE', errorDetail: 'Compensation window elapsed.' });
        return;
      }
      // Before the identity exists a user creation can still be undone; afterwards everything converges.
      if (saga.sagaType === 'user-creation' && (saga.status === 'started' || saga.status === 'reserved')) {
        logger.warn({ sagaId: saga.id }, 'user provisioning deadline reached; compensating');
        await compensate(client, store, saga, 'DEPENDENCY_UNAVAILABLE', settings);
        return;
      }
      await store.update(saga.id, { status: saga.status, deadlineMs: settings.convergeWindowMs });
    },
  };
}
