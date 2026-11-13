import { afterAll, describe, expect, it } from 'vitest';
import { ConcurrencyConflictError, withTransaction } from '@medicitas/kernel';
import { CLINIC_1, runtimePool } from '../../support/database.js';

const pool = runtimePool('sch', 'medicitas_scheduler');
afterAll(async () => pool.end());

const receptionist = {
  tenantId: CLINIC_1,
  actorSubject: '30000000-0000-4000-8000-000000010002',
  dbRole: 'sch_receptionist',
  isolation: 'READ COMMITTED' as const,
};

describe('withTransaction', () => {
  it('switches to the actor role and tenant only for the transaction', async () => {
    const inside = await withTransaction(pool, receptionist, async (client) => {
      const { rows } = await client.query<{ role: string; tenant: string; count: string; foreign: string }>(
        `SELECT current_user AS role, current_setting('app.tenant_id') AS tenant,
                (SELECT count(*) FROM appointments) AS count,
                (SELECT count(*) FROM appointments WHERE tenant_id <> $1) AS foreign`,
        [CLINIC_1],
      );
      return rows[0];
    });
    expect(inside).toMatchObject({ role: 'sch_receptionist', tenant: CLINIC_1, foreign: '0' });
    expect(Number(inside?.count)).toBeGreaterThan(0);

    // The pooled connection is back to the privilege-less login with no tenant.
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ role: string; tenant: string }>(
        "SELECT current_user AS role, current_setting('app.tenant_id', true) AS tenant",
      );
      expect(rows[0]?.role).toBe('sch_app');
      expect(rows[0]?.tenant ?? '').toBe('');
      await expect(client.query('SELECT 1 FROM scheduling.appointments LIMIT 1')).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
  });

  it('sees no rows without a tenant context (RLS rejects absent context)', async () => {
    const count = await withTransaction(pool, { ...receptionist, tenantId: null }, async (client) => {
      const { rows } = await client.query<{ count: string }>('SELECT count(*) FROM appointments');
      return Number(rows[0]?.count);
    });
    expect(count).toBe(0);
  });

  it('uses the requested isolation level explicitly', async () => {
    const level = await withTransaction(pool, { ...receptionist, isolation: 'REPEATABLE READ', readOnly: true }, async (client) => {
      const { rows } = await client.query<{ level: string; ro: string }>(
        "SELECT current_setting('transaction_isolation') AS level, current_setting('transaction_read_only') AS ro",
      );
      return rows[0];
    });
    expect(level).toEqual({ level: 'repeatable read', ro: 'on' });
  });

  it('replays the transaction on serialization failures and deadlocks', async () => {
    let attempts = 0;
    const result = await withTransaction(pool, receptionist, async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('could not serialize access'), { code: '40001' });
      if (attempts === 2) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('gives up with CONCURRENCY_CONFLICT after the retry budget', async () => {
    let attempts = 0;
    await expect(
      withTransaction(
        pool,
        receptionist,
        async () => {
          attempts += 1;
          throw Object.assign(new Error('lock timeout'), { code: '55P03' });
        },
        { maxRetries: 2 },
      ),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);
    expect(attempts).toBe(3);
  });

  it('never retries business violations and rolls them back', async () => {
    let attempts = 0;
    await expect(
      withTransaction(pool, receptionist, async () => {
        attempts += 1;
        throw Object.assign(new Error('exclusion violation'), { code: '23P01' });
      }),
    ).rejects.toMatchObject({ code: '23P01' });
    expect(attempts).toBe(1);
  });

  it('rejects role names that are not plain identifiers before touching the database', async () => {
    await expect(
      withTransaction(pool, { ...receptionist, dbRole: 'sch_receptionist; DROP TABLE x' }, async () => 1),
    ).rejects.toThrow(/Invalid database role/);
  });
});
