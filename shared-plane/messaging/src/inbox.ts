import type { DatabaseClient } from '@medicitas/kernel';
import { EnvelopeSchema, type Envelope } from './envelope.js';

export type InboxClaim =
  | { readonly duplicate: false }
  | { readonly duplicate: true; readonly storedReply: Envelope | null };

/**
 * Inserts the inbox row in the SAME transaction as the message effects (ADR-0003).
 * A duplicate delivery finds the row and must not re-apply effects; for commands, the stored
 * reply is returned so it can be re-published to a requester that lost the first one.
 */
export async function claimInbox(client: DatabaseClient, consumer: string, envelope: Envelope): Promise<InboxClaim> {
  const inserted = await client.query(
    `INSERT INTO inbox_messages (consumer, message_id, tenant_id, message_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ON CONSTRAINT inbox_messages_pk DO NOTHING
     RETURNING message_id`,
    [consumer, envelope.messageId, envelope.tenantId, envelope.messageType],
  );
  if (inserted.rowCount === 1) return { duplicate: false };

  const existing = await client.query<{ reply_envelope: unknown }>(
    'SELECT reply_envelope FROM inbox_messages WHERE consumer = $1 AND message_id = $2',
    [consumer, envelope.messageId],
  );
  const raw = existing.rows[0]?.reply_envelope;
  const parsed = raw === undefined || raw === null ? null : EnvelopeSchema.safeParse(raw);
  return { duplicate: true, storedReply: parsed !== null && parsed.success ? parsed.data : null };
}

export async function storeInboxReply(
  client: DatabaseClient,
  consumer: string,
  messageId: string,
  reply: Envelope,
): Promise<void> {
  await client.query('UPDATE inbox_messages SET reply_envelope = $3 WHERE consumer = $1 AND message_id = $2', [
    consumer,
    messageId,
    JSON.stringify(reply),
  ]);
}
