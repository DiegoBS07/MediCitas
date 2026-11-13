import { z } from 'zod';
import { parseConfig } from '@medicitas/kernel';
import { serviceConfigFromEnv, serviceEnvSchema, type ServiceConfig } from '@medicitas/runtime';

/** Scheduler-specific settings: Redis cache and the hold-expiry sweeper. */
export interface SchedulerConfig extends ServiceConfig {
  readonly redis: { readonly host: string; readonly port: number; readonly username: string; readonly password: string } | null;
  readonly cacheTtlSeconds: number;
  readonly holdSweepIntervalMs: number;
}

const schedulerEnvSchema = serviceEnvSchema.extend({
  AVAILABILITY_CACHE_ENABLED: z.enum(['true', 'false']).default('true'),
  AVAILABILITY_CACHE_TTL_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
  REDIS_HOST: z.string().min(1).default('redis'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65_535).default(6379),
  REDIS_USERNAME: z.string().min(1).default('scheduler'),
  REDIS_PASSWORD: z.string().min(1),
  HOLD_SWEEP_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
});

export function schedulerConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): SchedulerConfig {
  const parsed = parseConfig(schedulerEnvSchema, env);
  return {
    ...serviceConfigFromEnv(parsed, 'scheduler-management'),
    redis:
      parsed.AVAILABILITY_CACHE_ENABLED === 'true'
        ? { host: parsed.REDIS_HOST, port: parsed.REDIS_PORT, username: parsed.REDIS_USERNAME, password: parsed.REDIS_PASSWORD }
        : null,
    cacheTtlSeconds: parsed.AVAILABILITY_CACHE_TTL_SECONDS,
    holdSweepIntervalMs: parsed.HOLD_SWEEP_INTERVAL_MS,
  };
}
