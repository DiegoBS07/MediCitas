import { readonlyPool } from '../../support/database.js';

/**
 * Read-only evidence straight from the scheduler database (login sch_readonly: SELECT on
 * non-sensitive columns, RLS applies, so the tenant context is set per transaction). Used to prove
 * that what the API answered is what the database holds.
 */
export async function schedulerEvidence<T>(tenantId: string, sql: string, params: readonly unknown[]): Promise<T[]> {
  const pool = readonlyPool('sch', 'medicitas_scheduler');
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await client.query(sql, [...params]);
    await client.query('COMMIT');
    return result.rows as T[];
  } finally {
    client.release();
    await pool.end();
  }
}

/** Active (booked or held) appointments of a professional, with their interval. */
export async function activeAppointments(tenantId: string, professionalId: string): Promise<{ id: string; starts_at: Date; ends_at: Date; status: string }[]> {
  return schedulerEvidence(
    tenantId,
    `SELECT id, starts_at, ends_at, status FROM scheduling.appointments
      WHERE professional_id = $1 AND status IN ('booked', 'held') ORDER BY starts_at`,
    [professionalId],
  );
}

/** I1 evidence: pairs of active appointments of the same professional whose intervals overlap. */
export async function professionalOverlaps(tenantId: string, professionalId: string): Promise<number> {
  const rows = await schedulerEvidence<{ n: string }>(
    tenantId,
    `SELECT count(*) AS n FROM scheduling.appointments a
       JOIN scheduling.appointments b ON b.professional_id = a.professional_id AND a.id < b.id AND a.slot && b.slot
      WHERE a.professional_id = $1 AND a.status IN ('booked', 'held') AND b.status IN ('booked', 'held')`,
    [professionalId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** I2 evidence: pairs of active appointments of the same patient whose intervals overlap. */
export async function patientOverlaps(tenantId: string, patientId: string): Promise<number> {
  const rows = await schedulerEvidence<{ n: string }>(
    tenantId,
    `SELECT count(*) AS n FROM scheduling.appointments a
       JOIN scheduling.appointments b ON b.patient_id = a.patient_id AND a.id < b.id AND a.slot && b.slot
      WHERE a.patient_id = $1 AND a.status IN ('booked', 'held') AND b.status IN ('booked', 'held')`,
    [patientId],
  );
  return Number(rows[0]?.n ?? 0);
}
