import { randomUUID } from 'node:crypto';
import { ownerPool } from '../../support/database.js';

/**
 * "Clock" fixture for RF12/RF15. The API rightly refuses to book in the past (SLOT_IN_PAST) and
 * refuses an outcome before the start time (OUTCOME_BEFORE_START, database clock), so a test cannot
 * reach "after the appointment started" without waiting for real time to pass. This helper inserts a
 * booked appointment N days in the past with the scheduler OWNER role (migrations role). It is the
 * only acceptance fixture that bypasses the API, and every production constraint and trigger still
 * validates the row (exclusion constraints I1/I2, schedule I3, duration I4, RLS WITH CHECK).
 */
export async function insertPastAppointment(input: {
  readonly tenantId: string;
  readonly professionalId: string;
  readonly serviceId: string;
  readonly patientId: string;
  readonly bookedBy: string;
  readonly daysAgo: number;
  readonly localTime: string; // HH:mm on the 15-minute grid of the professional's schedule (UTC-6)
  readonly durationMinutes?: number;
}): Promise<{ readonly appointmentId: string; readonly startAt: string }> {
  const owner = ownerPool('sch', 'medicitas_scheduler');
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Costa_Rica' }).format(new Date(Date.now() - input.daysAgo * 86_400_000));
  const startAt = `${date}T${input.localTime}:00-06:00`;
  const appointmentId = randomUUID();
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path TO scheduling, app, public');
    await client.query(
      `INSERT INTO appointments (id, tenant_id, patient_id, professional_id, service_id, slot, status, booked_by_subject)
       VALUES ($1, $2, $3, $4, $5, tstzrange($6::timestamptz, $6::timestamptz + make_interval(mins => $8), '[)'), 'booked', $7)`,
      [appointmentId, input.tenantId, input.patientId, input.professionalId, input.serviceId, startAt, input.bookedBy, input.durationMinutes ?? 30],
    );
    await client.query('COMMIT');
    return { appointmentId, startAt };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
}
