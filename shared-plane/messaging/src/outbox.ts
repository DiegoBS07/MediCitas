import { withTransaction, type DatabaseClient, type DatabasePool } from '@medicitas/kernel';
import type { Logger } from '@medicitas/observability';
import { EnvelopeSchema, type Envelope } from './envelope.js';
import type { Publisher } from './publisher.js';

/**
 * Transactional outbox, write side: call inside the transaction that changes the state the
 * message announces. Nothing is published here; the relay does it after COMMIT.
 */
export async function enqueueOutbox(
  client: DatabaseClient,
  message: { readonly exchange: string; readonly routingKey: string; readonly envelope: Envelope },
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_messages (id, tenant_id, exchange, routing_key, message_type, envelope)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      message.envelope.messageId,
      message.envelope.tenantId,
      message.exchange,
      message.routingKey,
      message.envelope.messageType,
      JSON.stringify(message.envelope),
    ],
  );
}

export interface OutboxRelayConfig {
  /** <prefix>_worker: cross-tenant discovery role with column-limited outbox grants. */
  readonly workerRole: string;
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly maxBackoffMs?: number;
}

interface OutboxRow {
  readonly id: string;
  readonly exchange: string;
  readonly routing_key: string;
  readonly envelope: unknown;
  readonly attempts: number;
}

/**
 * Outbox relay. Claims pending rows with FOR UPDATE SKIP LOCKED (safe with N replicas), publishes
 * each on a confirm channel and marks it published ONLY after the publisher confirm. A failed
 * publish is rescheduled with exponential back-off. Woken by LISTEN/NOTIFY, polling as fallback.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private listener: DatabaseClient | undefined;
  private draining = false;
  private pending = false;
  private stopped = true;

  constructor(
    private readonly pool: DatabasePool,
    private readonly publisher: Publisher,
    private readonly config: OutboxRelayConfig,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    try {
      this.listener = await this.pool.connect();
      this.listener.on('notification', () => this.trigger());
      await this.listener.query('LISTEN outbox_new');
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'outbox LISTEN unavailable; polling only');
    }
    this.timer = setInterval(() => this.trigger(), this.config.pollIntervalMs ?? 1_000);
    this.trigger();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.listener !== undefined) {
      try {
        await this.listener.query('UNLISTEN outbox_new');
      } finally {
        this.listener.release();
        this.listener = undefined;
      }
    }
    while (this.draining) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  /** Publishes everything currently pending; resolves when a batch comes back empty. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const published = await this.publishBatch();
      total += published.claimed;
      if (published.claimed < (this.config.batchSize ?? 50)) return total;
    }
  }

  private trigger(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.pending = true;
      return;
    }
    this.draining = true;
    void this.drain()
      .catch((error: unknown) => this.logger.error({ err: (error as Error).message }, 'outbox drain failed'))
      .finally(() => {
        this.draining = false;
        if (this.pending) {
          this.pending = false;
          this.trigger();
        }
      });
  }

  private async publishBatch(): Promise<{ claimed: number }> {
    return withTransaction(
      this.pool,
      { tenantId: null, actorSubject: null, dbRole: this.config.workerRole, isolation: 'READ COMMITTED' },
      async (client) => {
        const { rows } = await client.query<OutboxRow>(
          `SELECT id, exchange, routing_key, envelope, attempts
           FROM outbox_messages
           WHERE published_at IS NULL AND available_at <= clock_timestamp()
           ORDER BY available_at, id
           LIMIT $1
           FOR UPDATE SKIP LOCKED`,
          [this.config.batchSize ?? 50],
        );
        for (const row of rows) {
          try {
            const envelope = EnvelopeSchema.parse(row.envelope);
            await this.publisher.publish(row.exchange, row.routing_key, envelope);
            await client.query(
              'UPDATE outbox_messages SET published_at = clock_timestamp(), attempts = attempts + 1, last_error = NULL WHERE id = $1',
              [row.id],
            );
          } catch (error) {
            const backoffMs = Math.min(500 * 2 ** row.attempts, this.config.maxBackoffMs ?? 30_000);
            await client.query(
              `UPDATE outbox_messages
               SET attempts = attempts + 1, last_error = $2,
                   available_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000)
               WHERE id = $1`,
              [row.id, (error as Error).message.slice(0, 500), backoffMs],
            );
            this.logger.warn({ outboxId: row.id, attempts: row.attempts + 1 }, 'outbox publish failed; rescheduled');
          }
        }
        return { claimed: rows.length };
      },
    );
  }
}
