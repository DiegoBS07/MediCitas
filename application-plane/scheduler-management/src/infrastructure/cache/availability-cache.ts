import { z } from 'zod';
import type { JsonCache } from '@medicitas/cache';
import type { Logger } from '@medicitas/observability';

/** Cached RF7 payload. The tenant and the version travel in the value and are re-checked on read. */
export const AvailabilityEntrySchema = z.object({
  tenantId: z.uuid(),
  professionalId: z.uuid(),
  serviceId: z.uuid(),
  date: z.iso.date(),
  timezone: z.string(),
  durationMinutes: z.number().int(),
  stepMinutes: z.number().int(),
  version: z.string(),
  generatedAt: z.string(),
  slots: z.array(z.object({ startAt: z.string(), endAt: z.string(), localStartTime: z.string() })),
});
export type AvailabilityEntry = z.infer<typeof AvailabilityEntrySchema>;

export interface AvailabilityKey {
  readonly tenantId: string;
  readonly professionalId: string;
  readonly serviceId: string;
  readonly date: string;
  /** "{scheduleVersion}.{dateVersion}.{serviceVersion}", read in the same snapshot as the data. */
  readonly version: string;
}

export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';

export function availabilityKey(key: AvailabilityKey): string {
  return `availability:v1:tenant:${key.tenantId}:professional:${key.professionalId}:service:${key.serviceId}:date:${key.date}:version:${key.version}`;
}

export function availabilityIndexKey(tenantId: string, professionalId: string, date: string): string {
  return `availability:v1:index:tenant:${tenantId}:professional:${professionalId}:date:${date}`;
}

/**
 * Version-keyed availability cache. Redis is never a source of truth: a failure is reported as
 * BYPASS (computed from PostgreSQL), and a value whose identity fields do not match the request is
 * treated as a miss and logged as a security warning.
 */
export class AvailabilityCache {
  constructor(
    private readonly cache: JsonCache | null,
    private readonly ttlSeconds: number,
    private readonly logger: Logger,
  ) {}

  get enabled(): boolean {
    return this.cache !== null;
  }

  async read(key: AvailabilityKey): Promise<{ readonly status: CacheStatus; readonly entry: AvailabilityEntry | null }> {
    if (this.cache === null) return { status: 'BYPASS', entry: null };
    const result = await this.cache.get(availabilityKey(key), AvailabilityEntrySchema);
    if (result.status === 'bypass') {
      this.logger.warn({ reason: result.reason }, 'availability cache unavailable; computing from PostgreSQL');
      return { status: 'BYPASS', entry: null };
    }
    if (result.status === 'miss') return { status: 'MISS', entry: null };
    const entry = result.value;
    const matches =
      entry.tenantId === key.tenantId &&
      entry.professionalId === key.professionalId &&
      entry.serviceId === key.serviceId &&
      entry.date === key.date &&
      entry.version === key.version;
    if (!matches) {
      this.logger.warn({ professionalId: key.professionalId, date: key.date }, 'cache entry identity mismatch; ignored (possible tampering)');
      return { status: 'MISS', entry: null };
    }
    return { status: 'HIT', entry };
  }

  async write(key: AvailabilityKey, entry: AvailabilityEntry): Promise<void> {
    if (this.cache === null) return;
    await this.cache.set(availabilityKey(key), entry, this.ttlSeconds, availabilityIndexKey(key.tenantId, key.professionalId, key.date));
  }

  /** Best-effort deletion of the entries of the affected (professional, dates); correctness relies on versions. */
  async invalidate(tenantId: string, professionalId: string, dates: readonly string[]): Promise<void> {
    if (this.cache === null) return;
    for (const date of dates) await this.cache.invalidateIndex(availabilityIndexKey(tenantId, professionalId, date));
  }
}
