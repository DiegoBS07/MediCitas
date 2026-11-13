import {
  PermanentMessageError,
  ReplyPayloadSchema,
  eventHandler,
  type HandlerRuntime,
  type MessageHandler,
} from '@medicitas/messaging';
import { PgSagaStore, type SagaHooks, type SagaRunner, type SagaTables } from '@medicitas/runtime';

export const REPLIES_QUEUE = 'user-management-orchestrator.replies';

const REPLY_STEPS: Readonly<Record<string, string>> = {
  UserReservedReply: 'reserve_user',
  UserActivatedReply: 'activate_user',
  UserReservationCancelledReply: 'cancel_reservation',
  UserRoleChangedReply: 'change_role',
  UserDeactivatedReply: 'deactivate_user',
};

/**
 * Replies of user-management, consumed through the inbox and serialized per saga by a row lock.
 * Stale replies (older command id) and duplicates are ignored.
 */
export function replyHandlers(
  runtime: HandlerRuntime,
  tables: SagaTables,
  hooks: SagaHooks,
  runner: SagaRunner,
): Readonly<Record<string, readonly MessageHandler<unknown>[]>> {
  const handlers = Object.entries(REPLY_STEPS).map(([messageType, stepName]) =>
    eventHandler(runtime, REPLIES_QUEUE, {
      messageType,
      allowedProducers: ['user-management'],
      allowedActorRoles: ['clinic_admin'],
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
        // Cancelling a reservation that never happened is already "done".
        const notFoundIsDone = stepName === 'cancel_reservation' && payload.error?.code === 'RESOURCE_NOT_FOUND';
        await store.setStep(saga.id, stepName, {
          status: notFoundIsDone ? 'succeeded' : payload.outcome,
          result: payload.result,
          errorCode: payload.error?.code ?? null,
          nextAttemptMs: null,
        });
        await hooks.advance(client, store, saga);
        runner.kick();
      },
    }),
  );
  return { [REPLIES_QUEUE]: handlers as readonly MessageHandler<unknown>[] };
}
