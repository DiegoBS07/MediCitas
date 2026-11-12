/** A named readiness probe for one dependency (database, broker, cache, identity provider). */
export interface HealthCheck {
  readonly name: string;
  readonly check: () => Promise<void>;
}

export type HealthStatus = 'ok' | 'degraded';

export interface HealthReport {
  readonly status: HealthStatus;
  /** Per-dependency result; logged internally, never exposed in detail on public endpoints. */
  readonly checks: Readonly<Record<string, 'ok' | 'fail'>>;
}

export async function runHealthChecks(checks: readonly HealthCheck[], timeoutMs = 2_000): Promise<HealthReport> {
  const results = await Promise.all(
    checks.map(async (probe): Promise<[string, 'ok' | 'fail']> => {
      try {
        await withTimeout(probe.check(), timeoutMs);
        return [probe.name, 'ok'];
      } catch {
        return [probe.name, 'fail'];
      }
    }),
  );
  const status: HealthStatus = results.every(([, result]) => result === 'ok') ? 'ok' : 'degraded';
  return { status, checks: Object.fromEntries(results) };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('health check timeout')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
