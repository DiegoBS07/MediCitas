import type { DatabaseClient } from '@medicitas/kernel';
import { ReplyPayloadSchema } from '@medicitas/messaging';
import type { BookingSaga, SagaStatus, SagaStep, StepName, StepReply, StepStatus } from '../../domain/entities/booking-saga.js';

interface SagaRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly appointment_id: string;
  readonly patient_id: string;
  readonly professional_id: string;
  readonly service_id: string;
  readonly start_at: Date;
  readonly patient_mode: 'existing' | 'create';
  readonly status: SagaStatus;
  readonly result: Record<string, unknown> | null;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly actor_subject: string;
  readonly actor_role: 'clinic_admin' | 'receptionist';
  readonly correlation_id: string;
  readonly deadline_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const SAGA_COLUMNS = `id, tenant_id, appointment_id, patient_id, professional_id, service_id, start_at, patient_mode, status,
                      result, error_code, error_detail, actor_subject, actor_role, correlation_id, deadline_at, created_at, updated_at`;

const toSaga = (row: SagaRow): BookingSaga => ({
  id: row.id,
  tenantId: row.tenant_id,
  appointmentId: row.appointment_id,
  patientId: row.patient_id,
  professionalId: row.professional_id,
  serviceId: row.service_id,
  startAt: row.start_at,
  patientMode: row.patient_mode,
  status: row.status,
  result: row.result,
  errorCode: row.error_code,
  errorDetail: row.error_detail,
  actorSubject: row.actor_subject,
  actorRole: row.actor_role,
  correlationId: row.correlation_id,
  deadlineAt: row.deadline_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function toReply(raw: unknown): StepReply | null {
  if (raw === null || raw === undefined) return null;
  const parsed = ReplyPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface NewSaga {
  readonly id: string;
  readonly appointmentId: string;
  readonly patientId: string;
  readonly professionalId: string;
  readonly serviceId: string;
  readonly startAt: string;
  readonly patientMode: 'existing' | 'create';
  readonly actorSubject: string;
  readonly actorRole: 'clinic_admin' | 'receptionist';
  readonly correlationId: string;
  readonly deadlineMs: number;
}

export interface SagaUpdate {
  readonly status: SagaStatus;
  readonly result?: Readonly<Record<string, unknown>> | null;
  readonly errorCode?: string | null;
  readonly errorDetail?: string | null;
  readonly deadlineMs?: number;
}

/** Saga state (schema booking). Writes happen under RLS of the saga's tenant. */
export class PgSagaRepository {
  constructor(private readonly client: DatabaseClient) {}

  async insertSaga(saga: NewSaga): Promise<void> {
    await this.client.query(
      `INSERT INTO saga_instances (id, tenant_id, appointment_id, patient_id, professional_id, service_id, start_at, patient_mode,
                                   status, actor_subject, actor_role, correlation_id, deadline_at)
       VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, 'awaiting_participants', $8, $9, $10,
               clock_timestamp() + make_interval(secs => $11::double precision / 1000))`,
      [
        saga.id,
        saga.appointmentId,
        saga.patientId,
        saga.professionalId,
        saga.serviceId,
        saga.startAt,
        saga.patientMode,
        saga.actorSubject,
        saga.actorRole,
        saga.correlationId,
        saga.deadlineMs,
      ],
    );
  }

  /** First dispatch of a step (plain INSERT: the HTTP actor roles hold INSERT but not UPDATE). */
  async insertDispatchedStep(sagaId: string, name: StepName, commandMessageId: string, resendMs: number): Promise<void> {
    await this.client.query(
      `INSERT INTO saga_steps (tenant_id, saga_id, step_name, status, command_message_id, attempts, last_attempt_at, next_attempt_at)
       VALUES (app.current_tenant_id(), $1, $2, 'dispatched', $3, 1, clock_timestamp(),
               clock_timestamp() + make_interval(secs => $4::double precision / 1000))`,
      [sagaId, name, commandMessageId, resendMs],
    );
  }

  /** Dispatches (or re-dispatches with a new command id) a step from the saga engine (system role). */
  async dispatchStep(sagaId: string, name: StepName, commandMessageId: string, resendMs: number): Promise<void> {
    await this.client.query(
      `INSERT INTO saga_steps (tenant_id, saga_id, step_name, status, command_message_id, attempts, last_attempt_at, next_attempt_at)
       VALUES (app.current_tenant_id(), $1, $2, 'dispatched', $3, 1, clock_timestamp(),
               clock_timestamp() + make_interval(secs => $4::double precision / 1000))
       ON CONFLICT (saga_id, step_name) DO UPDATE
         SET status = 'dispatched', command_message_id = EXCLUDED.command_message_id, attempts = saga_steps.attempts + 1,
             last_attempt_at = EXCLUDED.last_attempt_at, next_attempt_at = EXCLUDED.next_attempt_at, result = NULL, error_code = NULL`,
      [sagaId, name, commandMessageId, resendMs],
    );
  }

  async findSaga(id: string, options: { readonly forUpdate?: boolean } = {}): Promise<BookingSaga | null> {
    const { rows } = await this.client.query<SagaRow>(
      `SELECT ${SAGA_COLUMNS} FROM saga_instances WHERE id = $1${options.forUpdate === true ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] === undefined ? null : toSaga(rows[0]);
  }

  async steps(sagaId: string): Promise<readonly SagaStep[]> {
    const { rows } = await this.client.query<{ step_name: StepName; status: StepStatus; command_message_id: string | null; result: unknown }>(
      'SELECT step_name, status, command_message_id, result FROM saga_steps WHERE saga_id = $1 ORDER BY step_name',
      [sagaId],
    );
    return rows.map((row) => ({ name: row.step_name, status: row.status, commandMessageId: row.command_message_id, reply: toReply(row.result) }));
  }

  async recordReply(sagaId: string, name: StepName, status: StepStatus, reply: StepReply): Promise<void> {
    await this.client.query(
      `UPDATE saga_steps SET status = $3, result = $4, error_code = $5, next_attempt_at = NULL WHERE saga_id = $1 AND step_name = $2`,
      [sagaId, name, status, JSON.stringify(reply), reply.error?.code ?? null],
    );
  }

  async updateSaga(id: string, update: SagaUpdate): Promise<void> {
    await this.client.query(
      `UPDATE saga_instances
       SET status = $2,
           result = CASE WHEN $3::boolean THEN $4::jsonb ELSE result END,
           error_code = CASE WHEN $5::boolean THEN $6 ELSE error_code END,
           error_detail = CASE WHEN $5::boolean THEN $7 ELSE error_detail END,
           deadline_at = CASE WHEN $8::double precision IS NULL THEN deadline_at
                              ELSE clock_timestamp() + make_interval(secs => $8::double precision / 1000) END,
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
        update.deadlineMs ?? null,
      ],
    );
  }

  /** Claims a due re-send (system role): bumps attempts and returns the command id to re-publish. */
  async claimResend(sagaId: string, name: StepName, resendMs: number): Promise<string | null> {
    const { rows } = await this.client.query<{ command_message_id: string | null }>(
      `UPDATE saga_steps SET attempts = attempts + 1, last_attempt_at = clock_timestamp(),
              next_attempt_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000)
       WHERE (saga_id, step_name) IN (
         SELECT saga_id, step_name FROM saga_steps
         WHERE saga_id = $1 AND step_name = $2 AND status = 'dispatched' AND next_attempt_at <= clock_timestamp()
         FOR UPDATE SKIP LOCKED)
       RETURNING command_message_id`,
      [sagaId, name, resendMs],
    );
    return rows[0]?.command_message_id ?? null;
  }
}
