import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GATEWAY } from './api.js';

const run = promisify(execFile);

/** The eight application containers of docker-compose.yml. */
export const SERVICE_CONTAINERS = [
  'api-gateway',
  'tenant-management',
  'onboarding-orchestrator',
  'user-management',
  'user-management-orchestrator',
  'catalog-service-management',
  'scheduler-management',
  'appointment-orchestrator',
] as const;

export type ComposeService = (typeof SERVICE_CONTAINERS)[number] | 'postgres' | 'rabbitmq' | 'redis' | 'keycloak';

/** Runs `docker compose …` in the repository root (the working directory of the test run). */
export async function compose(args: readonly string[], timeoutMs = 300_000): Promise<string> {
  const { stdout } = await run('docker', ['compose', ...args], { cwd: process.cwd(), timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export async function stopContainers(services: readonly ComposeService[]): Promise<void> {
  await compose(['stop', ...services]);
}

/** Starts containers again and waits until their healthchecks pass (no one-shot dependency re-runs). */
export async function startContainers(services: readonly ComposeService[]): Promise<void> {
  await compose(['up', '-d', '--wait', '--no-deps', ...services]);
}

export async function gatewayReady(): Promise<boolean> {
  try {
    const response = await fetch(`${GATEWAY}/health/ready`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Health of one container as reported by Docker ('healthy', 'unhealthy', 'starting' or the state). */
export async function containerHealth(service: ComposeService): Promise<string> {
  const id = (await compose(['ps', '-q', service])).trim();
  if (id === '') return 'absent';
  const { stdout } = await run('docker', ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', id], {
    windowsHide: true,
  });
  return stdout.trim();
}
