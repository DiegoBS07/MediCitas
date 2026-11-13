import { existsSync } from 'node:fs';
import { SERVICE_CONTAINERS, compose, startContainers } from '../acceptance/support/stack.js';

/**
 * Integration tests start each domain service IN-PROCESS and consume that service's real queues.
 * If the Compose service containers ran at the same time, both would compete for the same queues (as
 * two replicas would): replies and commands would be split between the test instance and the
 * container, and failure-injection tests would be defeated.
 *
 * So, when the service containers are consuming, this setup stops them (infrastructure keeps running)
 * and the teardown starts them again and waits for their healthchecks: `npm test` needs no manual
 * step. Set MEDICITAS_TEST_MANAGE_STACK=false to fail fast instead of touching containers.
 */
const SERVICE_QUEUE = /^[a-z-]+\.(commands|replies|queries|events\.[a-z-]+)$/;

interface Consumer {
  readonly queue: { readonly name: string };
}

async function busyServiceQueues(): Promise<readonly string[]> {
  const user = process.env['RABBITMQ_ADMIN_USER'];
  const password = process.env['RABBITMQ_ADMIN_PASSWORD'];
  const vhost = process.env['RABBITMQ_VHOST'];
  if (user === undefined || password === undefined || vhost === undefined) return []; // tests report the missing .env
  const port = process.env['RABBITMQ_MANAGEMENT_HOST_PORT'] ?? '15672';
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/consumers/${encodeURIComponent(vhost)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [];
    const consumers = (await response.json()) as readonly Consumer[];
    return [...new Set(consumers.map((consumer) => consumer.queue.name).filter((name) => SERVICE_QUEUE.test(name)))].sort();
  } catch {
    return []; // broker unreachable: the tests themselves fail with a clearer error
  }
}

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const busy = await busyServiceQueues();
  if (busy.length === 0) return undefined;
  if (process.env['MEDICITAS_TEST_MANAGE_STACK'] === 'false') {
    throw new Error(
      `The service containers are consuming ${busy.length} service queue(s) (${busy.slice(0, 4).join(', ')}…). ` +
        'Integration tests run the services in-process: stop them with "npm run stack:services:stop" and start them again afterwards with "docker compose up -d --wait".',
    );
  }
  await compose(['stop', ...SERVICE_CONTAINERS]);
  return async () => {
    await startContainers(SERVICE_CONTAINERS);
  };
}
