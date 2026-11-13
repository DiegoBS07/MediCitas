import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import { deleteRunIdentities, onboardClinic, type AcceptanceFixture } from './support/fixture.js';
import { SERVICE_CONTAINERS, compose, containerHealth, gatewayReady } from './support/stack.js';

declare module 'vitest' {
  export interface ProvidedContext {
    acceptance: AcceptanceFixture;
  }
}

/**
 * Acceptance tests run black-box against the Compose stack (the eight service containers behind the
 * gateway). If the containers are not running (e.g. right after the in-process integration suite),
 * the stack is started here, so `npm test` needs no intermediate step.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const unhealthy: string[] = [];
  for (const service of SERVICE_CONTAINERS) if ((await containerHealth(service)) !== 'healthy') unhealthy.push(service);
  if (unhealthy.length > 0 || !(await gatewayReady())) {
    await compose(['up', '-d', '--wait'], 600_000);
  }
  const fixture = await onboardClinic(randomUUID().slice(0, 8));
  project.provide('acceptance', fixture);
  return async () => {
    await deleteRunIdentities(fixture);
  };
}
