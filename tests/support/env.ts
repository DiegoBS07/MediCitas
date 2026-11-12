/** Reads a required variable from .env (loaded by tests/support/load-env.ts). */
export function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing ${name}: run "cp .env.example .env" and start the stack (docker compose up).`);
  }
  return value;
}

export const HOST = '127.0.0.1';

export function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`condition not met within ${timeoutMs} ms`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
