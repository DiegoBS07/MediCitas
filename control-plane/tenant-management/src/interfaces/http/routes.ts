import type { Router } from 'express';
import { z } from 'zod';
import { withTransaction, type DatabasePool } from '@medicitas/kernel';
import { requirePermission } from '@medicitas/identity';
import { contextOf, cursorSchema, decodeCursor, limitSchema, parseInput, pathParams, sendData, toPage, uuidSchema } from '@medicitas/runtime';
import { TENANT_STATUSES } from '../../domain/entities/tenant.js';
import { getTenant, listTenants, toTenantView } from '../../application/queries/tenant-queries.js';
import { PgTenantRepository } from '../../infrastructure/persistence/pg-tenant-repository.js';

const listQuery = z
  .object({ status: z.enum(TENANT_STATUSES).optional(), limit: limitSchema, cursor: cursorSchema })
  .strict();
const cursorShape = z.tuple([z.string().min(1).max(64), uuidSchema]);

/** Control-plane reads: platform administrator only (tenants:read). */
export function tenantRoutes(pool: DatabasePool) {
  return (router: Router): void => {
    const platformRead = (subject: string) =>
      ({ tenantId: null, actorSubject: subject, dbRole: 'tm_platform_admin', isolation: 'READ COMMITTED', readOnly: true }) as const;

    router.get('/api/v1/tenants', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'tenants:read');
      const query = parseInput(listQuery, req.query, 'query');
      const after = decodeCursor(query.cursor, cursorShape);
      const rows = await withTransaction(pool, platformRead(context.subject), (client) =>
        listTenants(new PgTenantRepository(client), {
          status: query.status ?? null,
          limit: query.limit,
          after: after === null ? null : { createdAt: after[0], id: after[1] },
        }),
      );
      const page = toPage(rows, query.limit, (row) => toTenantView(row.tenant), (row) => [row.createdAtExact, row.tenant.id]);
      res.status(200).json(page);
    });

    router.get('/api/v1/tenants/:tenantId', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'tenants:read');
      const { tenantId } = parseInput(pathParams({ tenantId: uuidSchema }), req.params, 'params');
      const tenant = await withTransaction(pool, platformRead(context.subject), (client) =>
        getTenant(new PgTenantRepository(client), tenantId),
      );
      sendData(res, 200, tenant);
    });
  };
}
