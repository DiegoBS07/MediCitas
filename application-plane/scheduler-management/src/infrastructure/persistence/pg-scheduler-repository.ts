import type { DatabaseClient } from '@medicitas/kernel';
import type { Appointment, Outcome } from '../../domain/entities/appointment.js';
import { appointmentNotFound, guardConstraints } from '../../domain/errors/scheduler-errors.js';
import type { WeeklyBlock } from '../../domain/services/weekly-schedule.js';
import type {
  AuditEntry,
  CalendarBlock,
  ConflictRow,
  NewAppointment,
  ProfessionalReplica,
  SchedulerRepository,
  ServiceReplica,
  SlotContext,
} from '../../application/ports/scheduler-ports.js';

export interface AppointmentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly patient_id: string;
  readonly professional_id: string;
  readonly service_id: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly duration_minutes: number;
  readonly timezone: string;
  readonly status: Appointment['status'];
  readonly hold_expires_at: Date | null;
  readonly saga_id: string | null;
  readonly rescheduled_from_id: string | null;
  readonly rescheduled_to_id: string | null;
  readonly booked_by_subject: string;
  readonly cancel_reason: string | null;
  readonly cancelled_by_subject: string | null;
  readonly cancelled_at: Date | null;
  readonly outcome_recorded_by_subject: string | null;
  readonly outcome_recorded_at: Date | null;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Columns of an appointment with its timezone and successor (alias a = appointments, t = tenants). */
export const APPOINTMENT_COLUMNS = `
  a.id, a.tenant_id, a.patient_id, a.professional_id, a.service_id, a.starts_at, a.ends_at,
  (extract(epoch FROM a.ends_at - a.starts_at) / 60)::int AS duration_minutes, t.timezone, a.status,
  a.hold_expires_at, a.saga_id, a.rescheduled_from_id,
  (SELECT r.id FROM appointments r WHERE r.tenant_id = a.tenant_id AND r.rescheduled_from_id = a.id) AS rescheduled_to_id,
  a.booked_by_subject, a.cancel_reason, a.cancelled_by_subject, a.cancelled_at, a.outcome_recorded_by_subject,
  a.outcome_recorded_at, a.version, a.created_at, a.updated_at`;

export const toAppointment = (row: AppointmentRow): Appointment => ({
  id: row.id,
  tenantId: row.tenant_id,
  patientId: row.patient_id,
  professionalId: row.professional_id,
  serviceId: row.service_id,
  startAt: row.starts_at,
  endAt: row.ends_at,
  durationMinutes: row.duration_minutes,
  timezone: row.timezone,
  status: row.status,
  holdExpiresAt: row.hold_expires_at,
  sagaId: row.saga_id,
  rescheduledFromId: row.rescheduled_from_id,
  rescheduledToId: row.rescheduled_to_id,
  bookedBySubject: row.booked_by_subject,
  cancelReason: row.cancel_reason,
  cancelledBySubject: row.cancelled_by_subject,
  cancelledAt: row.cancelled_at,
  outcomeRecordedBySubject: row.outcome_recorded_by_subject,
  outcomeRecordedAt: row.outcome_recorded_at,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface ProfessionalRow {
  readonly id: string;
  readonly keycloak_subject: string;
  readonly display_name: string;
  readonly specialty_id: string;
  readonly status: 'active' | 'inactive';
}
const toProfessional = (row: ProfessionalRow): ProfessionalReplica => ({
  id: row.id,
  keycloakSubject: row.keycloak_subject,
  displayName: row.display_name,
  specialtyId: row.specialty_id,
  status: row.status,
});

interface BlockRow {
  readonly id: string;
  readonly professional_id: string;
  readonly start_at: Date;
  readonly end_at: Date;
  readonly reason: CalendarBlock['reason'];
  readonly note: string | null;
  readonly status: CalendarBlock['status'];
  readonly created_at: Date;
}
const BLOCK_COLUMNS = 'id, professional_id, lower(period) AS start_at, upper(period) AS end_at, reason, note, status, created_at';
const toBlock = (row: BlockRow): CalendarBlock => ({
  id: row.id,
  professionalId: row.professional_id,
  startAt: row.start_at,
  endAt: row.end_at,
  reason: row.reason,
  note: row.note,
  status: row.status,
  createdAt: row.created_at,
});

/** A weekly block contains the appointment (alias a, tenant t) — same rule as the insert trigger (I3). */
const INSIDE_WORKING_HOURS = `EXISTS (
  SELECT 1 FROM weekly_schedule_blocks b
  WHERE b.tenant_id = a.tenant_id AND b.professional_id = a.professional_id
    AND b.day_of_week = extract(isodow FROM (a.starts_at AT TIME ZONE t.timezone))
    AND ((a.starts_at AT TIME ZONE t.timezone)::date + b.start_time) AT TIME ZONE t.timezone <= a.starts_at
    AND ((a.starts_at AT TIME ZONE t.timezone)::date + b.end_time) AT TIME ZONE t.timezone >= a.ends_at)`;
const IN_CALENDAR_BLOCK = `EXISTS (
  SELECT 1 FROM calendar_blocks cb
  WHERE cb.tenant_id = a.tenant_id AND cb.professional_id = a.professional_id AND cb.status = 'active'
    AND lower(cb.period) < a.ends_at AND upper(cb.period) > a.starts_at)`;

/** PostgreSQL adapter of the scheduler (schema scheduling). tenant_id always comes from app.current_tenant_id(). */
export class PgSchedulerRepository implements SchedulerRepository {
  constructor(private readonly client: DatabaseClient) {}

  async lockAnchors(professionalIds: readonly string[], mode: 'SHARE' | 'UPDATE'): Promise<readonly string[]> {
    const sorted = [...new Set(professionalIds)].sort();
    const { rows } = await this.client.query<{ professional_id: string }>(
      `SELECT professional_id FROM professional_agendas WHERE professional_id = ANY($1::uuid[])
       ORDER BY professional_id FOR ${mode === 'SHARE' ? 'SHARE' : 'UPDATE'}`,
      [sorted],
    );
    return rows.map((row) => row.professional_id);
  }

  async bumpDateVersions(professionalId: string, dates: readonly string[]): Promise<Readonly<Record<string, number>>> {
    if (dates.length === 0) return {};
    const { rows } = await this.client.query<{ local_date: string; version: string }>(
      `SELECT to_char(local_date, 'YYYY-MM-DD') AS local_date, version
       FROM bump_availability_versions(app.current_tenant_id(), $1, $2::date[])`,
      [professionalId, [...new Set(dates)].sort()],
    );
    return Object.fromEntries(rows.map((row) => [row.local_date, Number(row.version)]));
  }

  async bumpScheduleVersion(professionalId: string): Promise<number> {
    const { rows } = await this.client.query<{ schedule_version: string }>(
      `UPDATE professional_agendas SET schedule_version = schedule_version + 1, updated_at = clock_timestamp()
       WHERE professional_id = $1 RETURNING schedule_version`,
      [professionalId],
    );
    return Number(rows[0]?.schedule_version ?? 0);
  }

  async scheduleVersion(professionalId: string): Promise<number> {
    const { rows } = await this.client.query<{ schedule_version: string }>(
      'SELECT schedule_version FROM professional_agendas WHERE professional_id = $1',
      [professionalId],
    );
    return Number(rows[0]?.schedule_version ?? 0);
  }

  async tenantTimezone(): Promise<string> {
    const { rows } = await this.client.query<{ timezone: string }>('SELECT timezone FROM tenants WHERE id = app.current_tenant_id()');
    const timezone = rows[0]?.timezone;
    if (timezone === undefined) throw new Error('tenant replica missing');
    return timezone;
  }

  async professional(id: string): Promise<ProfessionalReplica | null> {
    const { rows } = await this.client.query<ProfessionalRow>(
      'SELECT id, keycloak_subject, display_name, specialty_id, status FROM catalog_professionals WHERE id = $1',
      [id],
    );
    return rows[0] === undefined ? null : toProfessional(rows[0]);
  }

  async professionalBySubject(subject: string): Promise<ProfessionalReplica | null> {
    const { rows } = await this.client.query<ProfessionalRow>(
      'SELECT id, keycloak_subject, display_name, specialty_id, status FROM catalog_professionals WHERE keycloak_subject = $1',
      [subject],
    );
    return rows[0] === undefined ? null : toProfessional(rows[0]);
  }

  async service(id: string): Promise<ServiceReplica | null> {
    const { rows } = await this.client.query<{ id: string; name: string; duration_minutes: number; status: 'active' | 'inactive'; version: number }>(
      'SELECT id, name, duration_minutes, status, version FROM catalog_services WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { id: row.id, name: row.name, durationMinutes: row.duration_minutes, status: row.status, version: row.version };
  }

  async offers(professionalId: string, serviceId: string): Promise<boolean> {
    const { rowCount } = await this.client.query(
      'SELECT 1 FROM catalog_professional_services WHERE professional_id = $1 AND service_id = $2',
      [professionalId, serviceId],
    );
    return rowCount === 1;
  }

  async slotContext(startAt: string, durationMinutes: number): Promise<SlotContext> {
    const { rows } = await this.client.query<{
      timezone: string;
      start_at: Date;
      end_at: Date;
      local_date: string;
      in_past: boolean;
      beyond_horizon: boolean;
      hold_ttl_seconds: number;
    }>(
      `SELECT t.timezone,
              $1::timestamptz AS start_at,
              $1::timestamptz + make_interval(mins => $2::int) AS end_at,
              to_char(($1::timestamptz AT TIME ZONE t.timezone)::date, 'YYYY-MM-DD') AS local_date,
              $1::timestamptz <= now() AS in_past,
              ($1::timestamptz AT TIME ZONE t.timezone)::date > (now() AT TIME ZONE t.timezone)::date + st.booking_horizon_days AS beyond_horizon,
              st.hold_ttl_seconds
       FROM tenants t CROSS JOIN scheduling_settings st
       WHERE t.id = app.current_tenant_id()`,
      [startAt, durationMinutes],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('tenant replica missing');
    return {
      timezone: row.timezone,
      startAt: row.start_at,
      endAt: row.end_at,
      localDate: row.local_date,
      inPast: row.in_past,
      beyondHorizon: row.beyond_horizon,
      holdTtlSeconds: row.hold_ttl_seconds,
    };
  }

  async findAppointment(id: string, options: { readonly forUpdate?: boolean } = {}): Promise<Appointment | null> {
    const { rows } = await this.client.query<AppointmentRow>(
      `SELECT ${APPOINTMENT_COLUMNS} FROM appointments a JOIN tenants t ON t.id = a.tenant_id
       WHERE a.id = $1${options.forUpdate === true ? ' FOR UPDATE OF a' : ''}`,
      [id],
    );
    return rows[0] === undefined ? null : toAppointment(rows[0]);
  }

  private async reload(id: string): Promise<Appointment> {
    const appointment = await this.findAppointment(id);
    if (appointment === null) throw appointmentNotFound();
    return appointment;
  }

  async insertAppointment(appointment: NewAppointment): Promise<Appointment> {
    await guardConstraints(() =>
      this.client.query(
        `INSERT INTO appointments (id, tenant_id, patient_id, professional_id, service_id, slot, status, hold_expires_at,
                                   saga_id, rescheduled_from_id, booked_by_subject)
         VALUES ($1, app.current_tenant_id(), $2, $3, $4, tstzrange($5, $6, '[)'), $7,
                 CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(secs => $8::int) END, $9, $10, $11)`,
        [
          appointment.id,
          appointment.patientId,
          appointment.professionalId,
          appointment.serviceId,
          appointment.startAt,
          appointment.endAt,
          appointment.status,
          appointment.holdTtlSeconds,
          appointment.sagaId,
          appointment.rescheduledFromId,
          appointment.bookedBySubject,
        ],
      ),
    );
    return this.reload(appointment.id);
  }

  private async update(id: string, assignments: string, params: readonly unknown[]): Promise<Appointment> {
    await guardConstraints(() =>
      this.client.query(`UPDATE appointments SET ${assignments}, version = version + 1 WHERE id = $1`, [id, ...params]),
    );
    return this.reload(id);
  }

  confirmHold(id: string): Promise<Appointment> {
    return this.update(id, "status = 'booked'", []);
  }

  releaseHold(id: string, reasonCode: string): Promise<Appointment> {
    return this.update(id, "status = 'released', release_reason_code = $2", [reasonCode]);
  }

  markRescheduled(id: string): Promise<Appointment> {
    return this.update(id, "status = 'rescheduled'", []);
  }

  cancel(id: string, reason: string, bySubject: string): Promise<Appointment> {
    return this.update(id, "status = 'cancelled', cancel_reason = $2, cancelled_by_subject = $3, cancelled_at = now()", [reason, bySubject]);
  }

  recordOutcome(id: string, outcome: Outcome, bySubject: string): Promise<Appointment> {
    return this.update(id, 'status = $2, outcome_recorded_by_subject = $3, outcome_recorded_at = now()', [outcome, bySubject]);
  }

  async localDateOf(instant: Date): Promise<string> {
    const { rows } = await this.client.query<{ local_date: string }>(
      `SELECT to_char(($1::timestamptz AT TIME ZONE t.timezone)::date, 'YYYY-MM-DD') AS local_date
       FROM tenants t WHERE t.id = app.current_tenant_id()`,
      [instant],
    );
    return rows[0]?.local_date ?? instant.toISOString().slice(0, 10);
  }

  async dbNow(): Promise<Date> {
    const { rows } = await this.client.query<{ now: Date }>('SELECT now() AS now');
    return (rows[0] as { now: Date }).now;
  }

  async replaceWeeklyBlocks(professionalId: string, blocks: readonly WeeklyBlock[]): Promise<void> {
    await this.client.query('DELETE FROM weekly_schedule_blocks WHERE professional_id = $1', [professionalId]);
    if (blocks.length === 0) return;
    await guardConstraints(() =>
      this.client.query(
        `INSERT INTO weekly_schedule_blocks (tenant_id, professional_id, day_of_week, start_time, end_time)
         SELECT app.current_tenant_id(), $1, x.d, x.s::time, x.e::time
         FROM unnest($2::int[], $3::text[], $4::text[]) AS x(d, s, e)`,
        [professionalId, blocks.map((block) => block.dayOfWeek), blocks.map((block) => block.startTime), blocks.map((block) => block.endTime)],
      ),
    );
  }

  async weeklyBlocks(professionalId: string): Promise<readonly WeeklyBlock[]> {
    const { rows } = await this.client.query<{ day_of_week: number; start_time: string; end_time: string }>(
      `SELECT day_of_week, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
       FROM weekly_schedule_blocks WHERE professional_id = $1 ORDER BY day_of_week, start_time`,
      [professionalId],
    );
    return rows.map((row) => ({ dayOfWeek: row.day_of_week, startTime: row.start_time, endTime: row.end_time }));
  }

  async insertCalendarBlock(block: Parameters<SchedulerRepository['insertCalendarBlock']>[0]): Promise<CalendarBlock> {
    const { rows } = await guardConstraints(() =>
      this.client.query<BlockRow>(
        `INSERT INTO calendar_blocks (id, tenant_id, professional_id, period, reason, note, created_by_subject)
         VALUES ($1, app.current_tenant_id(), $2, tstzrange($3::timestamptz, $4::timestamptz, '[)'), $5, $6, $7)
         RETURNING ${BLOCK_COLUMNS}`,
        [block.id, block.professionalId, block.startAt, block.endAt, block.reason, block.note, block.createdBySubject],
      ),
    );
    return toBlock(rows[0] as BlockRow);
  }

  async findCalendarBlock(professionalId: string, blockId: string, options: { readonly forUpdate?: boolean } = {}): Promise<CalendarBlock | null> {
    const { rows } = await this.client.query<BlockRow>(
      `SELECT ${BLOCK_COLUMNS} FROM calendar_blocks WHERE id = $1 AND professional_id = $2${options.forUpdate === true ? ' FOR UPDATE' : ''}`,
      [blockId, professionalId],
    );
    return rows[0] === undefined ? null : toBlock(rows[0]);
  }

  async removeCalendarBlock(blockId: string, bySubject: string): Promise<void> {
    await this.client.query(
      "UPDATE calendar_blocks SET status = 'removed', removed_by_subject = $2, removed_at = now() WHERE id = $1",
      [blockId, bySubject],
    );
  }

  async listCalendarBlocks(professionalId: string, from: string, to: string): Promise<readonly CalendarBlock[]> {
    const { rows } = await this.client.query<BlockRow>(
      `SELECT ${BLOCK_COLUMNS} FROM calendar_blocks cb
       WHERE professional_id = $1
         AND lower(period) < (SELECT (($3::date + 1)::timestamp AT TIME ZONE t.timezone) FROM tenants t WHERE t.id = app.current_tenant_id())
         AND upper(period) > (SELECT ($2::date::timestamp AT TIME ZONE t.timezone) FROM tenants t WHERE t.id = app.current_tenant_id())
       ORDER BY lower(period), id`,
      [professionalId, from, to],
    );
    return rows.map(toBlock);
  }

  async localDatesSpanned(startAt: Date, endAt: Date): Promise<readonly string[]> {
    const { rows } = await this.client.query<{ dates: string[] | null }>(
      `SELECT array_agg(to_char(d, 'YYYY-MM-DD') ORDER BY d) AS dates
       FROM tenants t, unnest(local_dates_spanned(tstzrange($1::timestamptz, $2::timestamptz, '[)'), t.timezone)) AS d
       WHERE t.id = app.current_tenant_id()`,
      [startAt, endAt],
    );
    return rows[0]?.dates ?? [];
  }

  async bookedOverlapping(professionalId: string, startAt: Date, endAt: Date): Promise<readonly Appointment[]> {
    const { rows } = await this.client.query<AppointmentRow>(
      `SELECT ${APPOINTMENT_COLUMNS} FROM appointments a JOIN tenants t ON t.id = a.tenant_id
       WHERE a.professional_id = $1 AND a.status = 'booked' AND a.starts_at < $3 AND a.ends_at > $2
       ORDER BY a.starts_at, a.id`,
      [professionalId, startAt, endAt],
    );
    return rows.map(toAppointment);
  }

  async futureOutsideWorkingHours(professionalId: string): Promise<readonly Appointment[]> {
    const { rows } = await this.client.query<AppointmentRow>(
      `SELECT ${APPOINTMENT_COLUMNS} FROM appointments a JOIN tenants t ON t.id = a.tenant_id
       WHERE a.professional_id = $1 AND a.status = 'booked' AND a.starts_at > now() AND NOT ${INSIDE_WORKING_HOURS}
       ORDER BY a.starts_at, a.id`,
      [professionalId],
    );
    return rows.map(toAppointment);
  }

  async conflicts(filter: { readonly professionalId: string | null; readonly from: string; readonly to: string }): Promise<readonly ConflictRow[]> {
    const { rows } = await this.client.query<AppointmentRow & { outside_hours: boolean; blocked: boolean }>(
      `SELECT * FROM (
         SELECT ${APPOINTMENT_COLUMNS}, NOT ${INSIDE_WORKING_HOURS} AS outside_hours, ${IN_CALENDAR_BLOCK} AS blocked
         FROM appointments a JOIN tenants t ON t.id = a.tenant_id
         WHERE a.status = 'booked'
           AND ($1::uuid IS NULL OR a.professional_id = $1)
           AND a.starts_at >= ($2::date::timestamp AT TIME ZONE t.timezone)
           AND a.starts_at < (($3::date + 1)::timestamp AT TIME ZONE t.timezone)
       ) c
       WHERE c.outside_hours OR c.blocked
       ORDER BY c.starts_at, c.id
       LIMIT 500`,
      [filter.professionalId, filter.from, filter.to],
    );
    return rows.map((row) => ({ appointment: toAppointment(row), outsideWorkingHours: row.outside_hours, blocked: row.blocked }));
  }

  async insertNote(note: { readonly id: string; readonly appointmentId: string; readonly authorSubject: string; readonly content: string }): Promise<Date> {
    const { rows } = await guardConstraints(() =>
      this.client.query<{ created_at: Date }>(
        `INSERT INTO clinical_notes (id, tenant_id, appointment_id, author_subject, content)
         VALUES ($1, app.current_tenant_id(), $2, $3, $4) RETURNING created_at`,
        [note.id, note.appointmentId, note.authorSubject, note.content],
      ),
    );
    return (rows[0] as { created_at: Date }).created_at;
  }

  async findNote(appointmentId: string) {
    const { rows } = await this.client.query<{ id: string; author_subject: string; content: string; created_at: Date }>(
      'SELECT id, author_subject, content, created_at FROM clinical_notes WHERE appointment_id = $1',
      [appointmentId],
    );
    const row = rows[0];
    return row === undefined ? null : { id: row.id, authorSubject: row.author_subject, content: row.content, createdAt: row.created_at };
  }

  /**
   * Append-only insert (I6). No ON CONFLICT: that would need SELECT on audit_log, which only the clinic
   * admin holds. Consumers are de-duplicated by the inbox in the same transaction; the UNIQUE
   * source_message_id constraint is the last line of defence.
   */
  async insertAudit(entry: AuditEntry): Promise<void> {
    await this.client.query(
      `INSERT INTO audit_log (tenant_id, occurred_at, actor_subject, actor_role, patient_id, resource_type, resource_id,
                              action, outcome, correlation_id, source_service, source_message_id)
       VALUES (app.current_tenant_id(), COALESCE($1, clock_timestamp()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.occurredAt,
        entry.actorSubject,
        entry.actorRole,
        entry.patientId,
        entry.resourceType,
        entry.resourceId,
        entry.action,
        entry.outcome,
        entry.correlationId,
        entry.sourceService,
        entry.sourceMessageId,
      ],
    );
  }
}
