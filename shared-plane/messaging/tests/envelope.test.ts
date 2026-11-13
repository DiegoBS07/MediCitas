import { describe, expect, it } from 'vitest';
import { EnvelopeSchema, createEnvelope, createReply } from '../src/index.js';

const base = {
  messageType: 'HoldSlotCommand',
  producer: 'appointment-orchestrator' as const,
  tenantId: '10000000-0000-4000-8000-000000000001',
  actor: { subject: '30000000-0000-4000-8000-000000010002', roles: ['receptionist' as const] },
  correlationId: '4b8a6f0e-2f8e-4b8e-9a51-0f8d0f3c2a11',
  sagaId: '55aa0000-0000-4000-8000-000000000001',
  stepId: 'slot',
  replyTo: 'appointment-orchestrator',
  payload: { appointmentId: 'a' },
};

describe('envelope', () => {
  it('creates a valid versioned envelope with generated id, timestamp and default causation', () => {
    const envelope = createEnvelope(base);
    expect(envelope.messageVersion).toBe(1);
    expect(envelope.causationId).toBe(base.correlationId);
    expect(EnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('rejects unknown fields, unknown producers, bad UUIDs and missing actor', () => {
    const valid = createEnvelope(base);
    expect(EnvelopeSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ ...valid, producer: 'api-gateway' }).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ ...valid, tenantId: 'clinic-1' }).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ ...valid, actor: { subject: 'x', roles: [] } }).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ ...valid, messageVersion: 0 }).success).toBe(false);
  });

  it('builds replies that keep correlation, saga and step and point causation/commandId to the command', () => {
    const command = createEnvelope(base);
    const reply = createReply(command, {
      messageType: 'SlotHeldReply',
      producer: 'scheduler-management',
      payload: { outcome: 'rejected', result: null, error: { code: 'SLOT_TAKEN', message: 'taken', retryable: false } },
    });
    expect(reply.correlationId).toBe(command.correlationId);
    expect(reply.sagaId).toBe(command.sagaId);
    expect(reply.stepId).toBe('slot');
    expect(reply.causationId).toBe(command.messageId);
    expect(reply.commandId).toBe(command.messageId);
    expect(reply.tenantId).toBe(command.tenantId);
    expect(reply.replyTo).toBeNull();
  });

  it('rejects replies with an invalid outcome', () => {
    const command = createEnvelope(base);
    expect(() =>
      createReply(command, {
        messageType: 'SlotHeldReply',
        producer: 'scheduler-management',
        payload: { outcome: 'maybe' as 'failed', result: null, error: null },
      }),
    ).toThrow();
  });
});
