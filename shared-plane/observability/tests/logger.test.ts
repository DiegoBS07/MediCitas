import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, runHealthChecks, runWithLogContext } from '../src/index.js';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('logger', () => {
  it('redacts credentials, tokens and personal data', () => {
    const { stream, lines } = capture();
    const logger = createLogger({ service: 'test' }, stream);
    logger.info(
      {
        headers: { authorization: 'Bearer eyJhbGciOi.secret.sig' },
        password: 'p4ss',
        body: { temporaryPassword: 'tmp', email: 'patient@mail.example', contact: { phone: '+506 8888 7777' } },
        clientSecret: 'shh',
        safe: 'visible',
      },
      'request',
    );
    const [line] = lines();
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('eyJhbGciOi');
    expect(serialized).not.toContain('p4ss');
    expect(serialized).not.toContain('tmp');
    expect(serialized).not.toContain('patient@mail.example');
    expect(serialized).not.toContain('+506');
    expect(serialized).not.toContain('shh');
    expect(serialized).toContain('visible');
  });

  it('adds correlation fields of the current context to every line', () => {
    const { stream, lines } = capture();
    const logger = createLogger({ service: 'test' }, stream);
    runWithLogContext({ correlationId: 'c-1', tenantId: 't-1' }, () => {
      runWithLogContext({ messageId: 'm-1' }, () => logger.info('inside'));
    });
    logger.info('outside');
    const [inside, outside] = lines();
    expect(inside).toMatchObject({ service: 'test', correlationId: 'c-1', tenantId: 't-1', messageId: 'm-1' });
    expect(outside?.['correlationId']).toBeUndefined();
  });
});

describe('health checks', () => {
  it('reports degraded when one dependency fails or times out', async () => {
    const report = await runHealthChecks(
      [
        { name: 'db', check: async () => undefined },
        { name: 'broker', check: async () => Promise.reject(new Error('down')) },
        { name: 'slow', check: () => new Promise<void>((resolve) => setTimeout(resolve, 500)) },
      ],
      100,
    );
    expect(report.status).toBe('degraded');
    expect(report.checks).toEqual({ db: 'ok', broker: 'fail', slow: 'fail' });
  });
});
