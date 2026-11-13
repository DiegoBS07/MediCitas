import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { withTransaction, type DatabasePool, type DatabaseClient } from '@medicitas/kernel';
import { requirePermission, requireTenant, type Permission, type TenantContext } from '@medicitas/identity';
import {
  contextOf,
  cursorSchema,
  decodeCursor,
  idempotencyKeyOf,
  limitSchema,
  messageActor,
  parseInput,
  pathParams,
  requestEvents,
  requestHash,
  runIdempotent,
  sendData,
  sendOutcome,
  tenantTransaction,
  toPage,
  uuidSchema,
  type StoredResponse,
} from '@medicitas/runtime';
import { CATALOG_STATUSES } from '../../domain/entities/catalog.js';
import { professionalNotFound, serviceNotFound } from '../../domain/errors/catalog-errors.js';
import {
  createService,
  createSpecialty,
  registerProfessional,
  replaceProfessionalServices,
  updateProfessional,
  updateService,
} from '../../application/commands/catalog-commands.js';
import type { UserDirectory } from '../../application/ports/catalog-ports.js';
import { toProfessionalView, toServiceView, toSpecialtyView } from '../../application/queries/views.js';
import { PgCatalogRepository } from '../../infrastructure/persistence/pg-catalog-repository.js';

const SERVICE = 'catalog-service-management';
const PREFIX = 'cat';

const nameCursor = z.tuple([z.string().max(200), uuidSchema]);
const pageQuery = { limit: limitSchema, cursor: cursorSchema };
const duration = z.number().int().min(5).max(480).multipleOf(5);
const license = z.string().regex(/^[A-Za-z0-9-]{2,30}$/, 'invalid license number');

const bodies = {
  specialty: z.object({ name: z.string().trim().min(2).max(80) }).strict(),
  service: z.object({ name: z.string().trim().min(2).max(120), specialtyId: uuidSchema, durationMinutes: duration }).strict(),
  servicePatch: z
    .object({ name: z.string().trim().min(2).max(120).optional(), durationMinutes: duration.optional(), status: z.enum(CATALOG_STATUSES).optional() })
    .strict()
    .refine((body) => Object.keys(body).length > 0, 'at least one field is required'),
  professional: z
    .object({ userId: uuidSchema, specialtyId: uuidSchema, displayName: z.string().trim().min(2).max(120), licenseNumber: license })
    .strict(),
  professionalPatch: z
    .object({
      displayName: z.string().trim().min(2).max(120).optional(),
      licenseNumber: license.optional(),
      specialtyId: uuidSchema.optional(),
      status: z.enum(CATALOG_STATUSES).optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, 'at least one field is required'),
  services: z
    .object({ serviceIds: z.array(uuidSchema).max(50).refine((ids) => new Set(ids).size === ids.length, 'service ids must be unique') })
    .strict(),
};

const serviceListQuery = z.object({ status: z.enum(CATALOG_STATUSES).optional(), specialtyId: uuidSchema.optional(), ...pageQuery }).strict();
const professionalListQuery = z
  .object({ status: z.enum(CATALOG_STATUSES).optional(), specialtyId: uuidSchema.optional(), serviceId: uuidSchema.optional(), ...pageQuery })
  .strict();

/** RF3/RF4 (api-contracts §3.4). Writes need catalog:manage; reads catalog:read. */
export function catalogRoutes(pool: DatabasePool, directory: UserDirectory) {
  const read = <T>(context: TenantContext, work: (repository: PgCatalogRepository) => Promise<T>): Promise<T> =>
    withTransaction(pool, tenantTransaction(PREFIX, context, { readOnly: true }), (client) => work(new PgCatalogRepository(client)));

  /** Mutation with optional Idempotency-Key, all inside one transaction. */
  async function mutate(
    req: Request,
    res: Response,
    permission: Permission,
    routeTemplate: string,
    body: unknown,
    work: (client: DatabaseClient, context: TenantContext) => Promise<StoredResponse>,
    location?: (responseBody: unknown) => string,
  ): Promise<void> {
    const context = contextOf(res);
    requirePermission(context, permission);
    const key = idempotencyKeyOf(req, false);
    const method = req.method as 'POST' | 'PUT' | 'PATCH';
    const outcome = await withTransaction(pool, tenantTransaction(PREFIX, context), (client) =>
      runIdempotent(client, { tenantId: context.tenantId, method, routeTemplate, key, requestHash: requestHash(body) }, () => work(client, context)),
    );
    sendOutcome(res, outcome, location === undefined ? {} : { Location: location(outcome.response.body) });
  }
  const createdId = (field: string) => (body: unknown): string => String((body as { data: Record<string, unknown> }).data[field]);

  return (router: Router): void => {
    router.post('/api/v1/specialties', async (req, res) => {
      const body = parseInput(bodies.specialty, req.body, 'body');
      await mutate(req, res, 'catalog:manage', '/api/v1/specialties', body, async (client, context) => {
        const specialty = await createSpecialty(new PgCatalogRepository(client), requestEvents(client, SERVICE, context), body.name);
        return { status: 201, body: { data: toSpecialtyView(specialty) } };
      });
    });

    router.get('/api/v1/specialties', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'catalog:read');
      const query = parseInput(z.object(pageQuery).strict(), req.query, 'query');
      const after = decodeCursor(query.cursor, nameCursor);
      const rows = await read(context, (repository) => repository.listSpecialties({ limit: query.limit + 1, after }));
      res.status(200).json(toPage(rows, query.limit, toSpecialtyView, (row) => [row.name.toLowerCase(), row.id]));
    });

    router.post('/api/v1/services', async (req, res) => {
      const body = parseInput(bodies.service, req.body, 'body');
      await mutate(
        req,
        res,
        'catalog:manage',
        '/api/v1/services',
        body,
        async (client, context) => {
          const service = await createService(new PgCatalogRepository(client), requestEvents(client, SERVICE, context), body);
          return { status: 201, body: { data: toServiceView(service) } };
        },
        (responseBody) => `/api/v1/services/${createdId('serviceId')(responseBody)}`,
      );
    });

    router.get('/api/v1/services', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'catalog:read');
      const query = parseInput(serviceListQuery, req.query, 'query');
      const after = decodeCursor(query.cursor, nameCursor);
      const rows = await read(context, (repository) =>
        repository.listServices({ status: query.status ?? null, specialtyId: query.specialtyId ?? null }, { limit: query.limit + 1, after }),
      );
      res.status(200).json(toPage(rows, query.limit, toServiceView, (row) => [row.name.toLowerCase(), row.id]));
    });

    router.get('/api/v1/services/:serviceId', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'catalog:read');
      const { serviceId } = parseInput(pathParams({ serviceId: uuidSchema }), req.params, 'params');
      const service = await read(context, (repository) => repository.findService(serviceId));
      if (service === null) throw serviceNotFound();
      sendData(res, 200, toServiceView(service));
    });

    router.patch('/api/v1/services/:serviceId', async (req, res) => {
      const { serviceId } = parseInput(pathParams({ serviceId: uuidSchema }), req.params, 'params');
      const body = parseInput(bodies.servicePatch, req.body, 'body');
      await mutate(req, res, 'catalog:manage', '/api/v1/services/:serviceId', { serviceId, ...body }, async (client, context) => {
        const service = await updateService(new PgCatalogRepository(client), requestEvents(client, SERVICE, context), { serviceId, ...body });
        return { status: 200, body: { data: toServiceView(service) } };
      });
    });

    router.post('/api/v1/professionals', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'catalog:manage');
      const body = parseInput(bodies.professional, req.body, 'body');
      // Correlated query to user-management BEFORE opening the transaction (no transaction held while waiting).
      const user = await directory.getTenantUser({
        tenantId: requireTenant(context),
        userId: body.userId,
        actor: messageActor(context),
        correlationId: context.correlationId,
      });
      await mutate(
        req,
        res,
        'catalog:manage',
        '/api/v1/professionals',
        body,
        async (client) => {
          const professional = await registerProfessional(new PgCatalogRepository(client), requestEvents(client, SERVICE, context), {
            ...body,
            user,
          });
          return { status: 201, body: { data: toProfessionalView(professional) } };
        },
        (responseBody) => `/api/v1/professionals/${createdId('professionalId')(responseBody)}`,
      );
    });

    router.get('/api/v1/professionals', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'catalog:read');
      const query = parseInput(professionalListQuery, req.query, 'query');
      const after = decodeCursor(query.cursor, nameCursor);
      const rows = await read(context, (repository) =>
        repository.listProfessionals(
          { status: query.status ?? null, specialtyId: query.specialtyId ?? null, serviceId: query.serviceId ?? null },
          { limit: query.limit + 1, after },
        ),
      );
      res.status(200).json(toPage(rows, query.limit, toProfessionalView, (row) => [row.displayName.toLowerCase(), row.id]));
    });

    router.get('/api/v1/professionals/:professionalId', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'catalog:read');
      const { professionalId } = parseInput(pathParams({ professionalId: uuidSchema }), req.params, 'params');
      const professional = await read(context, (repository) => repository.findProfessional(professionalId));
      if (professional === null) throw professionalNotFound();
      sendData(res, 200, toProfessionalView(professional));
    });

    router.patch('/api/v1/professionals/:professionalId', async (req, res) => {
      const { professionalId } = parseInput(pathParams({ professionalId: uuidSchema }), req.params, 'params');
      const body = parseInput(bodies.professionalPatch, req.body, 'body');
      await mutate(req, res, 'catalog:manage', '/api/v1/professionals/:professionalId', { professionalId, ...body }, async (client, context) => {
        const professional = await updateProfessional(new PgCatalogRepository(client), requestEvents(client, SERVICE, context), {
          professionalId,
          ...body,
        });
        return { status: 200, body: { data: toProfessionalView(professional) } };
      });
    });

    router.put('/api/v1/professionals/:professionalId/services', async (req, res) => {
      const { professionalId } = parseInput(pathParams({ professionalId: uuidSchema }), req.params, 'params');
      const body = parseInput(bodies.services, req.body, 'body');
      await mutate(req, res, 'catalog:manage', '/api/v1/professionals/:professionalId/services', { professionalId, ...body }, async (client, context) => {
        const result = await replaceProfessionalServices(new PgCatalogRepository(client), requestEvents(client, SERVICE, context), {
          professionalId,
          serviceIds: body.serviceIds,
        });
        return {
          status: 200,
          body: { data: { professionalId, serviceIds: result.serviceIds, version: result.professional.servicesVersion } },
        };
      });
    });

    router.get('/api/v1/professionals/:professionalId/services', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'catalog:read');
      const { professionalId } = parseInput(pathParams({ professionalId: uuidSchema }), req.params, 'params');
      const services = await read(context, async (repository) => {
        if ((await repository.findProfessional(professionalId)) === null) throw professionalNotFound();
        return repository.findServices(await repository.professionalServiceIds(professionalId));
      });
      sendData(res, 200, [...services].sort((a, b) => a.name.localeCompare(b.name)).map(toServiceView));
    });
  };
}
