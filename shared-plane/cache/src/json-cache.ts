import type { z } from 'zod';
import type { Logger } from '@medicitas/observability';
import type { RedisConnection } from './client.js';

/**
 * Result of a cache read. A Redis failure is reported as `bypass`, never disguised as a hit or
 * a miss: the caller computes from PostgreSQL and exposes X-Cache: BYPASS.
 */
export type CacheRead<T> =
  | { readonly status: 'hit'; readonly value: T }
  | { readonly status: 'miss' }
  | { readonly status: 'bypass'; readonly reason: 'unavailable' | 'error' };

/** JSON values in Redis, validated on read. Redis is a cache only; nothing here is authoritative. */
export class JsonCache {
  constructor(
    private readonly client: RedisConnection,
    private readonly logger: Logger,
  ) {}

  async get<T>(key: string, schema: z.ZodType<T>): Promise<CacheRead<T>> {
    if (!this.client.isReady) return { status: 'bypass', reason: 'unavailable' };
    let raw: string | null;
    try {
      raw = await this.client.get(key);
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'cache read failed; bypassing');
      return { status: 'bypass', reason: 'error' };
    }
    if (raw === null) return { status: 'miss' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'miss' };
    }
    const result = schema.safeParse(parsed);
    // A corrupt or foreign entry is treated as a miss (and will be overwritten).
    return result.success ? { status: 'hit', value: result.data } : { status: 'miss' };
  }

  /**
   * Best-effort write: SET … EX ttl NX, registering the key in an index set (same TTL) used for
   * targeted invalidation. Returns false when the cache is unavailable; callers ignore it.
   */
  async set(key: string, value: unknown, ttlSeconds: number, indexKey?: string): Promise<boolean> {
    if (!this.client.isReady) return false;
    try {
      const transaction = this.client
        .multi()
        .set(key, JSON.stringify(value), { expiration: { type: 'EX', value: ttlSeconds }, condition: 'NX' });
      if (indexKey !== undefined) {
        transaction.sAdd(indexKey, key).expire(indexKey, ttlSeconds);
      }
      await transaction.exec();
      return true;
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'cache write failed; ignored');
      return false;
    }
  }

  /** Deletes every key registered in the index set, and the set itself. Best effort. */
  async invalidateIndex(indexKey: string): Promise<number> {
    if (!this.client.isReady) return 0;
    try {
      const members = await this.client.sMembers(indexKey);
      if (members.length === 0) {
        await this.client.del(indexKey);
        return 0;
      }
      return await this.client.del([...members, indexKey]);
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'cache invalidation failed; TTL and versioned keys still protect I8');
      return 0;
    }
  }

  async delete(keys: readonly string[]): Promise<number> {
    if (keys.length === 0 || !this.client.isReady) return 0;
    try {
      return await this.client.del([...keys]);
    } catch {
      return 0;
    }
  }
}
