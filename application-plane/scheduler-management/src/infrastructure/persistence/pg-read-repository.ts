import type { DatabaseClient } from '@medicitas/kernel';
import type { Appointment, PublicStatus } from '../../domain/entities/appointment.js';
import { APPOINTMENT_COLUMNS, toAppointment, type AppointmentRow } from './pg-scheduler-repository.js';

export interface AvailabilityContext {
  readonly timezone: string;
  readonly today: string;
  readonly horizon: string;
  readonly now: Date;
  readonly stepMinutes: number;
  readonly professional: { readonly status: string; readonly scheduleVersion: number; readonly displayName: string } | null;
  readonly service: { readonly status: string; readonly durationMinutes: number; readonly version: number } | null;
  readonly offers: boolean;
  readonly dateVersion: number;
}

export interface Slot {
  readonly startAt: string;
  readonly endAt: string;
  readonly localStartTime: string;
}

export interface AgendaItem {
  readonly appointmentId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly status: string;
  readonly patientId: string;
  readonly professionalId: string;
  readonly professionalDisplayName: string;
  readonly serviceId: string;
  readonly serviceName: string;
}

export interface AuditRow {
  readonly auditId: string;
  readonly occurredAt: string;
  readonly occurredAtExact: string;
  readonly actorSubject: string;
  readonly actorRole: string;
  readonly patientId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly action: string;
  readonly outcome: string;
  readonly correlationId: string;
  readonly sourceService: string;
}

/** Read-side SQL of the scheduler (RF7, RF8, RF16, RF19–RF21). Runs under RLS of the caller's tenant. */
export class PgReadRepository {
  constructor(private readonly client: DatabaseClient) {}

  /** Versions and coherence facts read in the SAME snapshot as the slots (REPEATABLE READ). */
  async availabilityContext(professionalId: string, serviceId: string, date: string): Promise<AvailabilityContext> {
    const { rows } = await this.client.query<{
      timezone: string;
      today: string;
      horizon: string;
      now: Date;
      step: number;
      p_status: string | null;
      p_name: string | null;
      schedule_version: string | null;
      s_status: string | null;
      s_duration: number | null;
      s_version: number | null;
      offers: boolean;
      date_version: string | null;
    }>(
      `SELECT t.timezone,
              to_char((now() AT TIME ZONE t.timezone)::date, 'YYYY-MM-DD') AS today,
              to_char((now() AT TIME ZONE t.timezone)::date + st.booking_horizon_days, 'YYYY-MM-DD') AS horizon,
              now() AS now, st.slot_step_minutes AS step,
              p.status AS p_status, p.display_name AS p_name, ag.schedule_version,
              s.status AS s_status, s.duration_minutes AS s_duration, s.version AS s_version,
              EXISTS (SELECT 1 FROM catalog_professional_services ps WHERE ps.professional_id = $1 AND ps.service_id = $2) AS offers,
              (SELECT av.version FROM availability_versions av WHERE av.professional_id = $1 AND av.local_date = $3::date) AS date_version
       FROM tenants t
       CROSS JOIN scheduling_settings st
       LEFT JOIN catalog_professionals p ON p.id = $1
       LEFT JOIN professional_agendas ag ON ag.professional_id = $1
       LEFT JOIN catalog_services s ON s.id = $2
       WHERE t.id = app.current_tenant_id()`,
      [professionalId, serviceId, date],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('tenant replica missing');
    return {
      timezone: row.timezone,
      today: row.today,
      horizon: row.horizon,
      now: row.now,
      stepMinutes: row.step,
      professional:
        row.p_status === null ? null : { status: row.p_status, scheduleVersion: Number(row.schedule_version ?? 0), displayName: row.p_name ?? '' },
      service:
        row.s_status === null || row.s_duration === null || row.s_version === null
          ? null
          : { status: row.s_status, durationMinutes: row.s_duration, version: row.s_version },
      offers: row.offers,
      dateVersion: Number(row.date_version ?? 0),
    };
  }

  /** RF7 definition (database function compute_available_slots, shared with seeds and EXPLAIN evidence). */
  async computeSlots(professionalId: string, serviceId: string, date: string): Promise<readonly Slot[]> {
    const { rows } = await this.client.query<{ start_at: Date; end_at: Date; local_start: string }>(
      `SELECT c.start_at, c.end_at, to_char(c.start_at AT TIME ZONE t.timezone, 'HH24:MI') AS local_start
       FROM compute_available_slots($1, $2, $3::date) c
       CROSS JOIN tenants t WHERE t.id = app.current_tenant_id()
       ORDER BY c.start_at`,
      [professionalId, serviceId, date],
    );
    return rows.map((row) => ({ startAt: row.start_at.toISOString(), endAt: row.end_at.toISOString(), localStartTime: row.local_start }));
  }

  async activeProfessionalsOffering(serviceId: string): Promise<readonly { readonly id: string; readonly displayName: string }[]> {
    const { rows } = await this.client.query<{ id: string; display_name: string }>(
      `SELECT p.id, p.display_name FROM catalog_professionals p
       JOIN catalog_professional_services ps ON ps.professional_id = p.id AND ps.tenant_id = p.tenant_id
       WHERE ps.service_id = $1 AND p.status = 'active'
       ORDER BY p.display_name, p.id`,
      [serviceId],
    );
    return rows.map((row) => ({ id: row.id, displayName: row.display_name }));
  }

  async todayAndHorizon(): Promise<{ readonly today: string; readonly horizon: string; readonly timezone: string }> {
    const { rows } = await this.client.query<{ today: string; horizon: string; timezone: string }>(
      `SELECT t.timezone, to_char((now() AT TIME ZONE t.timezone)::date, 'YYYY-MM-DD') AS today,
              to_char((now() AT TIME ZONE t.timezone)::date + st.booking_horizon_days, 'YYYY-MM-DD') AS horizon
       FROM tenants t CROSS JOIN scheduling_settings st WHERE t.id = app.current_tenant_id()`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error('tenant replica missing');
    return row;
  }

  /** RF16: patient history, newest first (keyset on starts_at desc, id desc). */
  async patientHistory(input: {
    readonly patientId: string;
    readonly statuses: readonly PublicStatus[];
    readonly from: string | null;
    readonly to: string | null;
    readonly limit: number;
    readonly after: readonly [string, string] | null;
  }): Promise<readonly (Appointment & { readonly startsAtExact: string })[]> {
    const params: unknown[] = [input.patientId, input.statuses, input.from, input.to, input.limit];
    let keyset = '';
    if (input.after !== null) {
      params.push(...input.after);
      keyset = 'AND (a.starts_at, a.id) < ($6::timestamptz, $7::uuid)';
    }
    const { rows } = await this.client.query<AppointmentRow & { starts_at_exact: string }>(
      `SELECT ${APPOINTMENT_COLUMNS}, to_json(a.starts_at) #>> '{}' AS starts_at_exact
       FROM appointments a JOIN tenants t ON t.id = a.tenant_id
       WHERE a.patient_id = $1 AND a.status = ANY($2::text[])
         AND ($3::date IS NULL OR a.starts_at >= ($3::date::timestamp AT TIME ZONE t.timezone))
         AND ($4::date IS NULL OR a.starts_at < (($4::date + 1)::timestamp AT TIME ZONE t.timezone))
         ${keyset}
       ORDER BY a.starts_at DESC, a.id DESC
       LIMIT $5`,
      params,
    );
    return rows.map((row) => ({ ...toAppointment(row), startsAtExact: row.starts_at_exact }));
  }

  /** RF20: the day agenda (local date), all public statuses, without patient names. */
  async agenda(date: string, professionalId: string | null): Promise<readonly AgendaItem[]> {
    const { rows } = await this.client.query<{
      id: string;
      starts_at: Date;
      ends_at: Date;
      status: string;
      patient_id: string;
      professional_id: string;
      display_name: string;
      service_id: string;
      service_name: string;
    }>(
      `SELECT a.id, a.starts_at, a.ends_at, a.status, a.patient_id, a.professional_id, p.display_name,
              a.service_id, s.name AS service_name
       FROM appointments a
       JOIN tenants t ON t.id = a.tenant_id
       JOIN catalog_professionals p ON p.tenant_id = a.tenant_id AND p.id = a.professional_id
       JOIN catalog_services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id
       WHERE a.status IN ('booked', 'attended', 'no_show', 'cancelled', 'rescheduled')
         AND a.starts_at >= ($1::date::timestamp AT TIME ZONE t.timezone)
         AND a.starts_at < (($1::date + 1)::timestamp AT TIME ZONE t.timezone)
         AND ($2::uuid IS NULL OR a.professional_id = $2)
       ORDER BY a.starts_at, p.display_name, a.id`,
      [date, professionalId],
    );
    return rows.map((row) => ({
      appointmentId: row.id,
      startAt: row.starts_at.toISOString(),
      endAt: row.ends_at.toISOString(),
      status: row.status,
      patientId: row.patient_id,
      professionalId: row.professional_id,
      professionalDisplayName: row.display_name,
      serviceId: row.service_id,
      serviceName: row.service_name,
    }));
  }

  /** RF21: counts by status for local start dates in [from, to]. */
  async statusCounts(from: string, to: string, professionalId: string | null): Promise<Readonly<Record<string, number>>> {
    const { rows } = await this.client.query<{ status: string; total: string }>(
      `SELECT a.status, count(*) AS total
       FROM appointments a JOIN tenants t ON t.id = a.tenant_id
       WHERE a.status IN ('booked', 'attended', 'no_show', 'cancelled', 'rescheduled')
         AND a.starts_at >= ($1::date::timestamp AT TIME ZONE t.timezone)
         AND a.starts_at < (($2::date + 1)::timestamp AT TIME ZONE t.timezone)
         AND ($3::uuid IS NULL OR a.professional_id = $3)
       GROUP BY a.status`,
      [from, to, professionalId],
    );
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
  }

  /** RF19: parameterized filters only; newest first (keyset on occurred_at desc, id desc). */
  async auditLog(input: {
    readonly actorSubject: string | null;
    readonly patientId: string | null;
    readonly from: string | null;
    readonly to: string | null;
    readonly action: string | null;
    readonly resourceType: string | null;
    readonly limit: number;
    readonly after: readonly [string, string] | null;
  }): Promise<readonly AuditRow[]> {
    const params: unknown[] = [input.actorSubject, input.patientId, input.from, input.to, input.action, input.resourceType, input.limit];
    let keyset = '';
    if (input.after !== null) {
      params.push(...input.after);
      keyset = 'AND (occurred_at, id) < ($8::timestamptz, $9::uuid)';
    }
    const { rows } = await this.client.query<{
      id: string;
      occurred_at: Date;
      occurred_at_exact: string;
      actor_subject: string;
      actor_role: string;
      patient_id: string;
      resource_type: string;
      resource_id: string;
      action: string;
      outcome: string;
      correlation_id: string;
      source_service: string;
    }>(
      `SELECT id, occurred_at, to_json(occurred_at) #>> '{}' AS occurred_at_exact, actor_subject, actor_role, patient_id,
              resource_type, resource_id, action, outcome, correlation_id, source_service
       FROM audit_log
       WHERE ($1::uuid IS NULL OR actor_subject = $1)
         AND ($2::uuid IS NULL OR patient_id = $2)
         AND ($3::timestamptz IS NULL OR occurred_at >= $3)
         AND ($4::timestamptz IS NULL OR occurred_at < $4)
         AND ($5::text IS NULL OR action = $5)
         AND ($6::text IS NULL OR resource_type = $6)
         ${keyset}
       ORDER BY occurred_at DESC, id DESC
       LIMIT $7`,
      params,
    );
    return rows.map((row) => ({
      auditId: row.id,
      occurredAt: row.occurred_at.toISOString(),
      occurredAtExact: row.occurred_at_exact,
      actorSubject: row.actor_subject,
      actorRole: row.actor_role,
      patientId: row.patient_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      action: row.action,
      outcome: row.outcome,
      correlationId: row.correlation_id,
      sourceService: row.source_service,
    }));
  }
}
