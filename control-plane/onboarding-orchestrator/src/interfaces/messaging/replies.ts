import { PermanentMessageError, ReplyPayloadSchema, eventHandler, type HandlerRuntime, type MessageHandler } from '@medicitas/messaging';
import { PgSagaStore, type SagaHooks, type SagaRunner, type SagaTables } from '@medicitas/runtime';
import { sendCommand, type OnboardingSettings } from '../../application/onboarding-saga.js';

export const REPLIES_QUEUE = 'onboarding-orchestrator.replies';

const REPLY_STEPS: Readonly<Record<string, string>> = {
  TenantCreatedReply: 'create_tenant',
  TenantActivatedReply: 'activate_tenant',
  TenantOnboardingFailedReply: 'mark_tenant_failed',
};

/** Replies of tenant-management (inbox + saga row lock); stale and duplicate replies are ignored. */
export function replyHandlers(
  runtime: HandlerRuntime,
  tables: SagaTables,
  hooks: SagaHooks,
  runner: SagaRunner,
  settings: OnboardingSettings,
): Readonly<Record<string, readonly MessageHandler<unknown>[]>> {
  const handlers = Object.entries(REPLY_STEPS).map(([messageType, stepName]) =>
    eventHandler(runtime, REPLIES_QUEUE, {
      messageType,
      allowedProducers: ['tenant-management'],
      allowedActorRoles: ['platform_admin'],
      payloadSchemas: { 1: ReplyPayloadSchema },
      async apply(payload, { client, envelope }) {
        if (envelope.sagaId === null || envelope.commandId === null || envelope.stepId !== stepName) {
          throw new PermanentMessageError('INVALID_REPLY', 'reply without a valid saga, command or step');
        }
        const store = new PgSagaStore(client, tables);
        const saga = await store.find(envelope.sagaId, { forUpdate: true });
        if (saga === null) return;
        const step = (await store.steps(saga.id)).find((candidate) => candidate.name === stepName);
        if (step === undefined || step.commandMessageId !== envelope.commandId || step.status !== 'dispatched') return;
        await store.setStep(saga.id, stepName, { status: payload.outcome, result: payload.result, errorCode: payload.error?.code ?? null, nextAttemptMs: null });

        // A tenant created AFTER the saga gave up (late reply) is marked failed: no tenant stays "provisioning".
        const lateTenant = payload.result?.['tenantId'];
        if (stepName === 'create_tenant' && saga.status === 'failed' && payload.outcome === 'succeeded' && typeof lateTenant === 'string') {
          await store.update(saga.id, { status: 'failed', tenantId: lateTenant });
          await sendCommand(client, store, { ...saga, tenantId: lateTenant }, 'mark_tenant_failed', { tenantId: lateTenant, reasonCode: 'DEPENDENCY_UNAVAILABLE' }, settings);
          return;
        }
        await hooks.advance(client, store, saga);
        runner.kick();
      },
    }),
  );
  return { [REPLIES_QUEUE]: handlers as readonly MessageHandler<unknown>[] };
}
