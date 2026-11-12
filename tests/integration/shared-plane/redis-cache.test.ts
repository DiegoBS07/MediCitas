import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { z } from 'zod';
import { JsonCache, createCacheConnection, type RedisConnection } from '@medicitas/cache';
import { HOST, env } from '../../support/env.js';
import { silentLogger } from '../../support/broker.js';

const port = Number(process.env['REDIS_HOST_PORT'] ?? 6379);
const Entry = z.object({ tenantId: z.string(), slots: z.array(z.string()) }).strict();
let connection: RedisConnection;
let cache: JsonCache;

beforeAll(async () => {
  connection = createCacheConnection(
    { host: HOST, port, username: 'scheduler', password: env('REDIS_SCHEDULER_PASSWORD'), commandTimeoutMs: 500 },
    silentLogger,
  );
  await connection.connect();
  cache = new JsonCache(connection, silentLogger);
});
afterAll(async () => connection.close());

describe('Redis cache (ADR-0008) — cache only, fail fast, least privilege', () => {
  it('reports miss, then hit after a write; NX never overwrites an existing entry', async () => {
    const key = `availability:v1:test:${randomUUID()}`;
    expect(await cache.get(key, Entry)).toEqual({ status: 'miss' });
    expect(await cache.set(key, { tenantId: 't1', slots: ['08:00'] }, 60)).toBe(true);
    expect(await cache.get(key, Entry)).toEqual({ status: 'hit', value: { tenantId: 't1', slots: ['08:00'] } });
    await cache.set(key, { tenantId: 't1', slots: ['STALE'] }, 60);
    expect(await cache.get(key, Entry)).toMatchObject({ value: { slots: ['08:00'] } });
    await cache.delete([key]);
  });

  it('treats an entry that fails validation as a miss', async () => {
    const key = `availability:v1:test:${randomUUID()}`;
    await cache.set(key, { unexpected: true }, 60);
    expect(await cache.get(key, Entry)).toEqual({ status: 'miss' });
    await cache.delete([key]);
  });

  it('invalidates every key registered in an index set', async () => {
    const index = `availability:v1:index:test:${randomUUID()}`;
    const keys = [1, 2, 3].map((n) => `availability:v1:test:${randomUUID()}:${n}`);
    for (const key of keys) await cache.set(key, { tenantId: 't', slots: [] }, 60, index);
    expect(await cache.invalidateIndex(index)).toBe(keys.length + 1);
    for (const key of keys) expect(await cache.get(key, Entry)).toEqual({ status: 'miss' });
  });

  it('the scheduler ACL user cannot touch keys outside availability:* nor run admin commands', async () => {
    await expect(connection.get('session:other-service')).rejects.toThrow(/NOPERM/);
    await expect(connection.sendCommand(['FLUSHALL'])).rejects.toThrow(/NOPERM/);
    await expect(connection.sendCommand(['CONFIG', 'GET', 'maxmemory'])).rejects.toThrow(/NOPERM/);
  });

  it('the healthcheck user can only PING and the default user is disabled', async () => {
    const health = createClient({ socket: { host: HOST, port }, username: 'healthcheck', password: env('REDIS_HEALTHCHECK_PASSWORD') });
    await health.connect();
    try {
      expect(await health.ping()).toBe('PONG');
      await expect(health.get('availability:anything')).rejects.toThrow(/NOPERM/);
    } finally {
      await health.close();
    }
    // The default user is off: an unauthenticated client cannot even complete the handshake.
    const anonymous = createClient({ socket: { host: HOST, port, reconnectStrategy: false } });
    anonymous.on('error', () => undefined);
    await expect(anonymous.connect()).rejects.toThrow(/NOAUTH|WRONGPASS/);
    anonymous.destroy();
  });

  it('bypasses (never fakes a hit) when Redis is unreachable', async () => {
    const down = createCacheConnection(
      { host: HOST, port: 6390, username: 'scheduler', password: 'x', connectTimeoutMs: 200 },
      silentLogger,
    );
    down.connect().catch(() => undefined);
    const unreachable = new JsonCache(down, silentLogger);
    const started = Date.now();
    expect(await unreachable.get('availability:v1:test:x', Entry)).toEqual({ status: 'bypass', reason: 'unavailable' });
    expect(await unreachable.set('availability:v1:test:x', { tenantId: 't', slots: [] }, 60)).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
    down.destroy();
  });
});
