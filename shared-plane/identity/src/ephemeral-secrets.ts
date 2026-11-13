/**
 * In-memory, time-limited holder of a temporary password between the HTTP request that received
 * it and the saga step that sends it to Keycloak (ADR-0012). It is NEVER persisted: if the process
 * restarts (or another replica drives the saga) the secret is gone and the saga compensates with
 * PROVISIONING_INTERRUPTED; the client retries with a new Idempotency-Key.
 */
export class EphemeralSecrets {
  private readonly secrets = new Map<string, { readonly value: string; readonly timer: NodeJS.Timeout }>();

  constructor(private readonly ttlMs: number) {}

  put(key: string, value: string): void {
    this.delete(key);
    const timer = setTimeout(() => this.secrets.delete(key), this.ttlMs);
    timer.unref();
    this.secrets.set(key, { value, timer });
  }

  get(key: string): string | undefined {
    return this.secrets.get(key)?.value;
  }

  delete(key: string): void {
    const entry = this.secrets.get(key);
    if (entry !== undefined) clearTimeout(entry.timer);
    this.secrets.delete(key);
  }

  clear(): void {
    for (const key of [...this.secrets.keys()]) this.delete(key);
  }
}
