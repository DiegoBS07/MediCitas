import {
  PermanentMessageError,
  ReplyPayloadSchema,
  eventHandler,
  type HandlerRuntime,
  type MessageHandler,
  type ServiceName,
} from '@medicitas/messaging';
import { STEP_NAMES, type StepName } from '../../domain/entities/booking-saga.js';
import { applyReply, type SagaSettings } from '../../application/commands/booking-saga.js';

export const REPLIES_QUEUE = 'appointment-orchestrator.replies';

/** Reply type → the only service allowed to send it and the saga steps it may answer. */
const REPLIES: readonly { readonly messageType: string; readonly producer: ServiceName; readonly steps: readonly StepName[] }[] = [
  { messageType: 'PatientEnsuredReply', producer: 'user-management', steps: ['patient'] },
  { messageType: 'BookingCatalogValidatedReply', producer: 'catalog-service-management', steps: ['catalog'] },
  { messageType: 'SlotHeldReply', producer: 'scheduler-management', steps: ['slot'] },
  { messageType: 'AppointmentConfirmedReply', producer: 'scheduler-management', steps: ['confirm'] },
  { messageType: 'SlotReleasedReply', producer: 'scheduler-management', steps: ['release'] },
];

/** Replies are consumed through the inbox (duplicates ignored) and serialized per saga by a row lock. */
export function replyHandlers(runtime: HandlerRuntime, settings: SagaSettings): Readonly<Record<string, readonly MessageHandler<unknown>[]>> {
  const handlers = REPLIES.map((definition) =>
    eventHandler(runtime, REPLIES_QUEUE, {
      messageType: definition.messageType,
      allowedProducers: [definition.producer],
      allowedActorRoles: ['clinic_admin', 'receptionist'],
      payloadSchemas: { 1: ReplyPayloadSchema },
      async apply(payload, { client, envelope }) {
        const step = envelope.stepId as StepName | null;
        if (envelope.sagaId === null || envelope.commandId === null || step === null || !STEP_NAMES.includes(step) || !definition.steps.includes(step)) {
          throw new PermanentMessageError('INVALID_REPLY', 'reply without a valid saga, command or step');
        }
        await applyReply(client, settings, { sagaId: envelope.sagaId, step, commandId: envelope.commandId, payload }, runtime.logger);
      },
    }),
  );
  return { [REPLIES_QUEUE]: handlers as readonly MessageHandler<unknown>[] };
}
