import { existsSync } from 'node:fs';

/**
 * Integration tests start each domain service IN-PROCESS and consume that service's real queues.
 * If the Compose service containers are running too, both would compete for the same queues (as two
 * replicas would): replies and commands would be split between the test instance and the container,
 * and failure-injection tests would be defeated. Fail fast with the fix instead of flaky results.
 */
const SERVICE_QUEUE = /^[a-z-]+\.(commands|replies|queries|events\.[a-z-]+)$/;

interface Consumer {
  readonly queue: { readonly name: string };
}

export default async function setup(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const user = process.env['RABBITMQ_ADMIN_USER'];
  const password = process.env['RABBITMQ_ADMIN_PASSWORD'];
  const vhost = process.env['RABBITMQ_VHOST'];
  if (user === undefined || password === undefined || vhost === undefined) return; // tests report the missing .env
  const port = process.env['RABBITMQ_MANAGEMENT_HOST_PORT'] ?? '15672';
  let consumers: readonly Consumer[];
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/consumers/${encodeURIComponent(vhost)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return;
    consumers = (await response.json()) as readonly Consumer[];
  } catch {
    return; // broker unreachable: the tests themselves fail with a clearer error
  }
  const busy = [...new Set(consumers.map((consumer) => consumer.queue.name).filter((name) => SERVICE_QUEUE.test(name)))].sort();
  if (busy.length > 0) {
    throw new Error(
      `The service containers are running and consuming ${busy.length} service queue(s) (${busy.slice(0, 4).join(', ')}${busy.length > 4 ? ', …' : ''}). ` +
        'Integration tests run the services in-process: stop the containers first with "npm run stack:services:stop" ' +
        '(infrastructure keeps running), and start them again afterwards with "docker compose up -d --wait".',
    );
  }
}
