import { randomUUID } from 'node:crypto';
import type { SchedulerConfig } from '../../application-plane/scheduler-management/src/config.js';
import { HOST, env } from './env.js';
import { serviceConfig, type ServiceProbe } from './services.js';
import type { DatabasePool } from '@medicitas/kernel';

export function schedulerConfig(overrides: Partial<Pick<SchedulerConfig, 'redis' | 'holdSweepIntervalMs'>> = {}): SchedulerConfig {
  return {
    ...serviceConfig('sch', 'medicitas_scheduler', 'scheduler-management'),
    redis: {
      host: HOST,
      port: Number(process.env['REDIS_HOST_PORT'] ?? 6379),
      username: 'scheduler',
      password: env('REDIS_SCHEDULER_PASSWORD'),
    },
    cacheTtlSeconds: 300,
    holdSweepIntervalMs: 60_000,
    ...overrides,
  };
}

/** Local calendar date (YYYY-MM-DD) of `instant + days` in a timezone. */
export function localDate(timezone: string, days = 0, instant = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(instant.getTime() + days * 86_400_000));
}

/** Costa Rica has no DST: local time = UTC-6 (clinics 1 and 2). */
export function crInstant(date: string, time: string): string {
  return `${date}T${time}:00-06:00`;
}

export interface TestAgenda {
  readonly professionalId: string;
  readonly secondProfessionalId: string;
  readonly serviceId: string;
  readonly subject: string;
}

/**
 * Creates, through real catalog events, a fresh test professional pair offering a fresh 30-minute
 * service in clinic 1. Appointments can never be deleted (append-only history), so every run books
 * on its own professionals and never touches demo data.
 */
export async function publishTestCatalog(catalog: ServiceProbe, tenantId: string, runId: string): Promise<TestAgenda> {
  const actor = { subject: '30000000-0000-4000-8000-000000010001', roles: ['clinic_admin' as const] };
  const specialtyId = randomUUID();
  const serviceId = randomUUID();
  const agenda: TestAgenda = { professionalId: randomUUID(), secondProfessionalId: randomUUID(), serviceId, subject: randomUUID() };
  await catalog.event(
    'catalog.service.created',
    catalog.envelope({
      messageType: 'ServiceCreated',
      tenantId,
      actor,
      payload: { serviceId, name: `IT Service ${runId}`, specialtyId, durationMinutes: 30, status: 'active', aggregateVersion: 1 },
    }),
  );
  for (const [index, professionalId] of [agenda.professionalId, agenda.secondProfessionalId].entries()) {
    await catalog.event(
      'catalog.professional.registered',
      catalog.envelope({
        messageType: 'ProfessionalRegistered',
        tenantId,
        actor,
        payload: {
          professionalId,
          userId: randomUUID(),
          keycloakSubject: index === 0 ? agenda.subject : randomUUID(),
          displayName: `IT Professional ${runId} ${index}`,
          specialtyId,
          status: 'active',
          aggregateVersion: 1,
        },
      }),
    );
    await catalog.event(
      'catalog.professional.services-changed',
      catalog.envelope({
        messageType: 'ProfessionalServicesChanged',
        tenantId,
        actor,
        payload: { professionalId, serviceIds: [serviceId], aggregateVersion: 2 },
      }),
    );
  }
  return agenda;
}

/** Waits until the scheduler replica of a professional offers the service. */
export async function waitForReplica(owner: DatabasePool, professionalId: string, serviceId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rowCount } = await owner.query(
      'SELECT 1 FROM scheduling.catalog_professional_services WHERE professional_id = $1 AND service_id = $2',
      [professionalId, serviceId],
    );
    if (rowCount === 1) return;
    if (Date.now() > deadline) throw new Error('scheduler replica not ready');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
