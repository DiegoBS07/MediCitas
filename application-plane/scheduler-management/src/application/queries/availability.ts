import { BusinessRuleError, ValidationError } from '@medicitas/kernel';
import { professionalInactive, professionalNotFound, serviceNotFound } from '../../domain/errors/scheduler-errors.js';
import type { AvailabilityCache, AvailabilityEntry, CacheStatus } from '../../infrastructure/cache/availability-cache.js';
import type { AvailabilityContext, PgReadRepository } from '../../infrastructure/persistence/pg-read-repository.js';

export interface AvailabilityResult {
  readonly cache: CacheStatus;
  readonly entry: AvailabilityEntry;
  readonly now: Date;
}

function assertCoherent(context: AvailabilityContext): void {
  if (context.professional === null) throw professionalNotFound();
  if (context.service === null) throw serviceNotFound();
  if (context.professional.status !== 'active') throw professionalInactive();
  if (context.service.status !== 'active') throw new BusinessRuleError('SERVICE_INACTIVE', 'The service is inactive.');
  if (!context.offers) throw new BusinessRuleError('PROFESSIONAL_NOT_QUALIFIED', 'The professional does not offer this service.');
}

function assertWithinHorizon(context: { readonly today: string; readonly horizon: string }, date: string, path = 'query.date'): void {
  if (date < context.today || date > context.horizon) {
    throw new ValidationError('The date is outside the booking horizon.', [
      { path, message: `must be between ${context.today} and ${context.horizon}` },
    ]);
  }
}

/**
 * RF7 read path (ADR-0008). Must run inside a REPEATABLE READ READ ONLY transaction: the versions
 * and the slots come from one snapshot, so a cached value is always built from a coherent state.
 * Invalid or incoherent input never touches the cache.
 */
export async function availabilityFor(
  repository: PgReadRepository,
  cache: AvailabilityCache,
  input: { readonly tenantId: string; readonly professionalId: string; readonly serviceId: string; readonly date: string },
): Promise<AvailabilityResult> {
  const context = await repository.availabilityContext(input.professionalId, input.serviceId, input.date);
  assertWithinHorizon(context, input.date);
  assertCoherent(context);
  const professional = context.professional as NonNullable<AvailabilityContext['professional']>;
  const service = context.service as NonNullable<AvailabilityContext['service']>;
  const key = {
    tenantId: input.tenantId,
    professionalId: input.professionalId,
    serviceId: input.serviceId,
    date: input.date,
    version: `${professional.scheduleVersion}.${context.dateVersion}.${service.version}`,
  };
  const cached = await cache.read(key);
  if (cached.status === 'HIT' && cached.entry !== null) return { cache: 'HIT', entry: cached.entry, now: context.now };

  const entry: AvailabilityEntry = {
    tenantId: input.tenantId,
    professionalId: input.professionalId,
    serviceId: input.serviceId,
    date: input.date,
    timezone: context.timezone,
    durationMinutes: service.durationMinutes,
    stepMinutes: context.stepMinutes,
    version: key.version,
    generatedAt: new Date().toISOString(),
    slots: [...(await repository.computeSlots(input.professionalId, input.serviceId, input.date))],
  };
  if (cached.status === 'MISS') await cache.write(key, entry);
  return { cache: cached.status, entry, now: context.now };
}

/** Slots in the past are filtered AFTER the cache, so cached entries do not age with the clock. */
export function futureSlots(result: AvailabilityResult): AvailabilityEntry['slots'] {
  const now = result.now.getTime();
  return result.entry.slots.filter((slot) => Date.parse(slot.startAt) > now);
}

/** Inclusive list of local dates between two YYYY-MM-DD values. */
export function datesBetween(from: string, to: string): readonly string[] {
  const dates: string[] = [];
  for (let day = Date.parse(`${from}T00:00:00Z`); day <= Date.parse(`${to}T00:00:00Z`); day += 86_400_000) {
    dates.push(new Date(day).toISOString().slice(0, 10));
  }
  return dates;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export { assertWithinHorizon };
