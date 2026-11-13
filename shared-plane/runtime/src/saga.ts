import { isAppError, withTransaction, type DatabaseClient, type DatabasePool } from '@medicitas/kernel';
import { EXCHANGES, createEnvelope, enqueueOutbox, type ActorRole, type ServiceName } from '@medicitas/messaging';
import type { Logger } from '@medicitas/observability';

/**
 * Generic persisted process manager for the provisioning sagas (ADR-0012): onboarding (RF1) and
 * user provisioning (RF2). Both databases share the saga_instances / saga_steps shape.
 *
 * Steps are of two kinds:
 *  - command steps: a RabbitMQ command (outbox) awaiting a correlated reply;
 *  - local steps:   an idempotent Keycloak Admin REST call, executed OUTSIDE any database
 *                   transaction by the runner, under a lease (crash → re-run after the lease).
 */
export interface SagaTables {
  /** true for application-plane databases (saga_steps.tenant_id + RLS). */
  readonly tenantScoped: boolean;
  readonly workerRole: string;
  readonly systemRole: string;
}

export interface SagaRecord {
  readonly id: string;
  readonly tenantId: string | null;
  readonly sagaType: string;
  readonly status: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly actorSubject: string;
  readonly correlationId: string;
  readonly deadlineAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type SagaStepStatus = 'pending' | 'dispatched' | 'succeeded' | 'rejected' | 'failed' | 'compensating' | 'compensated' | 'skipped';

export interface SagaStepRecord {
  readonly name: string;
  readonly status: SagaStepStatus;
  readonly commandMessageId: string | null;
  readonly attempts: number;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
}

interface SagaRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly saga_type: string;
  readonly status: string;
  readonly request: Record<string, unknown>;
  readonly result: Record<string, unknown> | null;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly actor_subject: string;
  readonly correlation_id: string;
  readonly deadline_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PgSagaStore {
  constructor(
    private readonly client: DatabaseClient,
    private readonly tables: SagaTables,
  ) {}

  async find(id: string, options: { readonly forUpdate?: boolean } = {}): Promise<SagaRecord | null> {
    const { rows } = await this.client.query<SagaRow>(
      `SELECT id, tenant_id, saga_type, status, request, result, error_code, error_detail, actor_subject, correlation_id,
              deadline_at, created_at, updated_at
       FROM saga_instances WHERE id = $1${options.forUpdate === true ? ' FOR UPDATE' : ''}`,
      [id],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          tenantId: row.tenant_id,
          sagaType: row.saga_type,
          status: row.status,
          request: row.request,
          result: row.result,
          errorCode: row.error_code,
          errorDetail: row.error_detail,
          actorSubject: row.actor_subject,
          correlationId: row.correlation_id,
          deadlineAt: row.deadline_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
  }

  async steps(sagaId: string): Promise<readonly SagaStepRecord[]> {
    const { rows } = await this.client.query<{
      step_name: string;
      status: SagaStepStatus;
      command_message_id: string | null;
      attempts: number;
      result: Record<string, unknown> | null;
      error_code: string | null;
    }>('SELECT step_name, status, command_message_id, attempts, result, error_code FROM saga_steps WHERE saga_id = $1', [sagaId]);
    return rows.map((row) => ({
      name: row.step_name,
      status: row.status,
      commandMessageId: row.command_message_id,
      attempts: row.attempts,
      result: row.result,
      errorCode: row.error_code,
    }));
  }

  /** Upserts a step (first write may come from an HTTP actor role: INSERT only, no conflict). */
  async setStep(
    sagaId: string,
    name: string,
    state: {
      readonly status: SagaStepStatus;
      readonly commandMessageId?: string | null;
      readonly result?: Readonly<Record<string, unknown>> | null;
      readonly errorCode?: string | null;
      readonly nextAttemptMs?: number | null;
    },
    options: { readonly insertOnly?: boolean } = {},
  ): Promise<void> {
    const tenantColumn = this.tables.tenantScoped ? 'tenant_id, ' : '';
    const tenantValue = this.tables.tenantScoped ? 'app.current_tenant_id(), ' : '';
    const values = `VALUES (${tenantValue}$1, $2, $3, $4, $5, $6,
                    CASE WHEN $7::double precision IS NULL THEN NULL ELSE clock_timestamp() + make_interval(secs => $7::double precision / 1000) END,
                    CASE WHEN $3 = 'dispatched' THEN 1 ELSE 0 END, CASE WHEN $3 = 'dispatched' THEN clock_timestamp() END)`;
    const params = [
      sagaId,
      name,
      state.status,
      state.commandMessageId ?? null,
      state.result === undefined || state.result === null ? null : JSON.stringify(state.result),
      state.errorCode ?? null,
      state.nextAttemptMs ?? null,
    ];
    const insert = `INSERT INTO saga_steps (${tenantColumn}saga_id, step_name, status, command_message_id, result, error_code, next_attempt_at, attempts, last_attempt_at) ${values}`;
    if (options.insertOnly === true) {
      await this.client.query(insert, params);
      return;
    }
    await this.client.query(
      `${insert}
       ON CONFLICT (saga_id, step_name) DO UPDATE SET
         status = EXCLUDED.status,
         command_message_id = COALESCE(EXCLUDED.command_message_id, CASE WHEN EXCLUDED.status = 'pending' THEN NULL ELSE saga_steps.command_message_id END),
         result = COALESCE(EXCLUDED.result, saga_steps.result),
         error_code = EXCLUDED.error_code,
         next_attempt_at = EXCLUDED.next_attempt_at,
         attempts = saga_steps.attempts + CASE WHEN EXCLUDED.status = 'dispatched' THEN 1 ELSE 0 END,
         last_attempt_at = COALESCE(EXCLUDED.last_attempt_at, saga_steps.last_attempt_at)`,
      params,
    );
  }

  async update(
    id: string,
    update: {
      readonly status: string;
      readonly result?: Readonly<Record<string, unknown>> | null;
      readonly errorCode?: string | null;
      readonly errorDetail?: string | null;
      readonly tenantId?: string;
      readonly deadlineMs?: number;
    },
  ): Promise<void> {
    await this.client.query(
      `UPDATE saga_instances SET
         status = $2,
         result = CASE WHEN $3::boolean THEN $4::jsonb ELSE result END,
         error_code = CASE WHEN $5::boolean THEN $6 ELSE error_code END,
         error_detail = CASE WHEN $5::boolean THEN $7 ELSE error_detail END,
         tenant_id = COALESCE($8::uuid, tenant_id),
         deadline_at = CASE WHEN $9::double precision IS NULL THEN deadline_at
                            ELSE clock_timestamp() + make_interval(secs => $9::double precision / 1000) END,
         completed_at = CASE WHEN $2 IN ('completed', 'failed') THEN clock_timestamp() ELSE NULL END,
         version = version + 1
       WHERE id = $1`,
      [
        id,
        update.status,
        update.result !== undefined,
        update.result === undefined || update.result === null ? null : JSON.stringify(update.result),
        update.errorCode !== undefined,
        update.errorCode ?? null,
        update.errorDetail ?? null,
        update.tenantId ?? null,
        update.deadlineMs ?? null,
      ],
    );
  }
}

/** Sends a saga command through the outbox and marks its step as dispatched with the command id. */
export async function dispatchSagaCommand(
  client: DatabaseClient,
  store: PgSagaStore,
  input: {
    readonly producer: ServiceName;
    readonly saga: Pick<SagaRecord, 'id' | 'tenantId' | 'actorSubject' | 'correlationId'>;
    readonly actorRole: ActorRole;
    readonly step: string;
    readonly messageType: string;
    readonly routingKey: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly resendMs: number;
    readonly insertOnly?: boolean;
  },
): Promise<string> {
  const envelope = createEnvelope({
    messageType: input.messageType,
    producer: input.producer,
    tenantId: input.saga.tenantId,
    actor: { subject: input.saga.actorSubject, roles: [input.actorRole] },
    correlationId: input.saga.correlationId,
    sagaId: input.saga.id,
    stepId: input.step,
    replyTo: input.producer,
    payload: input.payload,
  });
  await enqueueOutbox(client, { exchange: EXCHANGES.commands, routingKey: input.routingKey, envelope });
  await store.setStep(
    input.saga.id,
    input.step,
    { status: 'dispatched', commandMessageId: envelope.messageId, nextAttemptMs: input.resendMs },
    input.insertOnly === true ? { insertOnly: true } : {},
  );
  return envelope.messageId;
}

/** Thrown by a local step that can never succeed (e.g. a genuine e-mail conflict in Keycloak). */
export class PermanentStepError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentStepError';
  }
}

export interface SagaHooks {
  /** Local (Keycloak) steps, executed outside transactions; must be idempotent. */
  readonly localSteps: Readonly<Record<string, (saga: SagaRecord, steps: readonly SagaStepRecord[]) => Promise<Readonly<Record<string, unknown>>>>>;
  /** Decides and records what happens next, inside a transaction that holds the saga row lock. */
  advance(client: DatabaseClient, store: PgSagaStore, saga: SagaRecord): Promise<void>;
  /** Deadline reached (inside a transaction that holds the saga row lock). */
  onDeadline(client: DatabaseClient, store: PgSagaStore, saga: SagaRecord): Promise<void>;
}

export interface SagaRunnerSettings {
  readonly resendMs: number;
  readonly localRetryMs: number;
  readonly leaseMs: number;
  readonly sweepIntervalMs: number;
}

interface DueStep {
  readonly tenant_id: string | null;
  readonly saga_id: string;
  readonly step_name: string;
}

/**
 * Background driver: re-sends unanswered commands (same messageId), executes due local steps and
 * applies deadlines. Safe with several replicas (FOR UPDATE SKIP LOCKED claims, leases).
 */
export class SagaRunner {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private again = false;

  constructor(
    private readonly pool: DatabasePool,
    private readonly tables: SagaTables,
    private readonly hooks: SagaHooks,
    private readonly settings: SagaRunnerSettings,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep(), this.settings.sweepIntervalMs);
    void this.sweep();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  /** Requests a sweep soon (e.g. right after a reply scheduled a local step). */
  kick(): void {
    setTimeout(() => void this.sweep(), 25).unref();
  }

  private system(tenantId: string | null) {
    return { tenantId, actorSubject: null, dbRole: this.tables.systemRole, isolation: 'READ COMMITTED' as const };
  }

  async sweep(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.runDueSteps();
        await this.applyDeadlines();
      } while (this.again);
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'saga sweep failed; retrying on the next tick');
    } finally {
      this.running = false;
    }
  }

  private async runDueSteps(): Promise<void> {
    const due = await withTransaction(
      this.pool,
      { tenantId: null, actorSubject: null, dbRole: this.tables.workerRole, isolation: 'READ COMMITTED', readOnly: true },
      async (client) =>
        (
          await client.query<DueStep>(
            `SELECT ${this.tables.tenantScoped ? 'tenant_id' : 'NULL::uuid AS tenant_id'}, saga_id, step_name FROM saga_steps
             WHERE status IN ('pending', 'dispatched') AND next_attempt_at <= clock_timestamp()
             ORDER BY next_attempt_at LIMIT 50`,
          )
        ).rows,
    );
    for (const step of due) await this.runStep(step);
  }

  private async runStep(step: DueStep): Promise<void> {
    const claimed = await withTransaction(this.pool, this.system(step.tenant_id), async (client) => {
      const { rows } = await client.query<{ command_message_id: string | null }>(
        `UPDATE saga_steps s SET status = 'dispatched', attempts = s.attempts + 1, last_attempt_at = clock_timestamp(),
                next_attempt_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000)
         FROM (SELECT saga_id, step_name FROM saga_steps
               WHERE saga_id = $1 AND step_name = $2 AND status IN ('pending', 'dispatched') AND next_attempt_at <= clock_timestamp()
               FOR UPDATE SKIP LOCKED) due
         WHERE s.saga_id = due.saga_id AND s.step_name = due.step_name
         RETURNING s.command_message_id`,
        [step.saga_id, step.step_name, this.hooks.localSteps[step.step_name] === undefined ? this.settings.resendMs : this.settings.leaseMs],
      );
      return rows[0];
    });
    if (claimed === undefined) return;

    if (claimed.command_message_id !== null) {
      // Command step without reply: re-publish the SAME message (the participant inbox answers duplicates).
      await withTransaction(this.pool, { tenantId: null, actorSubject: null, dbRole: this.tables.workerRole, isolation: 'READ COMMITTED' }, (client) =>
        client.query('UPDATE outbox_messages SET published_at = NULL, available_at = clock_timestamp() WHERE id = $1', [claimed.command_message_id]),
      );
      this.logger.info({ sagaId: step.saga_id, step: step.step_name }, 'saga command re-sent');
      return;
    }

    const executor = this.hooks.localSteps[step.step_name];
    if (executor === undefined) return;
    const context = await withTransaction(this.pool, this.system(step.tenant_id), async (client) => {
      const store = new PgSagaStore(client, this.tables);
      return { saga: await store.find(step.saga_id), steps: await store.steps(step.saga_id) };
    });
    if (context.saga === null || context.saga.status === 'completed' || context.saga.status === 'failed') return;

    let outcome: { readonly status: 'succeeded' | 'failed' | 'retry'; readonly result?: Readonly<Record<string, unknown>>; readonly code?: string };
    try {
      outcome = { status: 'succeeded', result: await executor(context.saga, context.steps) };
    } catch (error) {
      if (error instanceof PermanentStepError) outcome = { status: 'failed', code: error.code };
      else if (isAppError(error) && !error.retryable) outcome = { status: 'failed', code: error.code };
      else outcome = { status: 'retry' };
      this.logger.warn({ sagaId: step.saga_id, step: step.step_name, outcome: outcome.status, code: outcome.code }, 'saga local step did not succeed');
    }

    await withTransaction(this.pool, this.system(step.tenant_id), async (client) => {
      const store = new PgSagaStore(client, this.tables);
      const saga = await store.find(step.saga_id, { forUpdate: true });
      if (saga === null) return;
      // A step skipped by a compensation in the meantime is only recorded if it actually succeeded.
      const current = (await store.steps(saga.id)).find((candidate) => candidate.name === step.step_name);
      if (current?.status === 'skipped' && outcome.status !== 'succeeded') return;
      if (outcome.status === 'retry') {
        await store.setStep(saga.id, step.step_name, { status: 'pending', nextAttemptMs: this.settings.localRetryMs });
        return;
      }
      await store.setStep(saga.id, step.step_name, {
        status: outcome.status,
        result: outcome.result ?? null,
        errorCode: outcome.code ?? null,
        nextAttemptMs: null,
      });
      await this.hooks.advance(client, store, saga);
    });
    this.kick();
  }

  private async applyDeadlines(): Promise<void> {
    const overdue = await withTransaction(
      this.pool,
      { tenantId: null, actorSubject: null, dbRole: this.tables.workerRole, isolation: 'READ COMMITTED', readOnly: true },
      async (client) =>
        (
          await client.query<{ id: string; tenant_id: string | null }>(
            `SELECT id, ${this.tables.tenantScoped ? 'tenant_id' : 'NULL::uuid AS tenant_id'} FROM saga_instances
             WHERE status NOT IN ('completed', 'failed') AND deadline_at <= clock_timestamp() ORDER BY deadline_at LIMIT 50`,
          )
        ).rows,
    );
    for (const saga of overdue) {
      await withTransaction(this.pool, this.system(saga.tenant_id), async (client) => {
        const store = new PgSagaStore(client, this.tables);
        const locked = await store.find(saga.id, { forUpdate: true });
        if (locked === null || locked.status === 'completed' || locked.status === 'failed') return;
        const { rows } = await client.query<{ overdue: boolean }>('SELECT deadline_at <= clock_timestamp() AS overdue FROM saga_instances WHERE id = $1', [
          saga.id,
        ]);
        if (rows[0]?.overdue === true) await this.hooks.onDeadline(client, store, locked);
      });
    }
  }
}

/** Polls a saga until it reaches a terminal status (or the timeout elapses). */
export async function waitForSaga(read: () => Promise<SagaRecord | null>, timeoutMs: number): Promise<SagaRecord | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const saga = await read();
    if (saga !== null && (saga.status === 'completed' || saga.status === 'failed')) return saga;
    if (Date.now() >= deadline) return saga;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(deadline - Date.now(), 1))));
  }
}
