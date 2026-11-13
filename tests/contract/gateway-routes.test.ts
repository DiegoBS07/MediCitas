import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../../application-plane/api-gateway/src/domain/route-table.js';

/**
 * Contract: the gateway routing table equals the route catalog of docs/contracts/api-contracts.md §2
 * (method, path, owner and permission), so code and documentation cannot drift apart.
 */
interface DocumentedRoute {
  readonly method: string;
  readonly path: string;
  readonly permissions: readonly string[];
  readonly owner: string;
}

function documentedRoutes(): readonly DocumentedRoute[] {
  const markdown = readFileSync('docs/contracts/api-contracts.md', 'utf8');
  const rows = markdown.split('\n').filter((line) => /^\| \d+ \| `(GET|POST|PUT|PATCH|DELETE) /.test(line));
  return rows.map((line) => {
    const cells = line.split('|').map((cell) => cell.trim());
    const [method, path] = (cells[2] ?? '').replaceAll('`', '').split(' ');
    const permissions = [...(cells[3] ?? '').matchAll(/`([a-z:-]+)`/g)].map((match) => match[1] as string);
    return { method: method ?? '', path: (path ?? '').replace(/\{([A-Za-z]+)\}/g, ':$1'), permissions, owner: cells[4] ?? '' };
  });
}

describe('gateway routes = documented REST catalog', () => {
  const documented = documentedRoutes();

  it('documents and implements the same 47 routes', () => {
    expect(documented).toHaveLength(47);
    const implemented = ROUTES.map((route) => `${route.method} ${route.path}`).sort();
    expect(implemented).toEqual(documented.map((route) => `${route.method} ${route.path}`).sort());
  });

  it('forwards every route to its documented owner with its documented permission', () => {
    for (const doc of documented) {
      const route = ROUTES.find((candidate) => candidate.method === doc.method && candidate.path === doc.path);
      expect(route, `${doc.method} ${doc.path}`).toBeDefined();
      expect(route?.upstream ?? 'api-gateway', `${doc.method} ${doc.path}`).toBe(doc.owner);
      if (Array.isArray(route?.access)) {
        expect([...route.access].sort(), `${doc.method} ${doc.path}`).toEqual([...doc.permissions].sort());
      } else if (route?.access === 'clinic-user') {
        // Clinical notes: the scheduler enforces clinical-notes:own and audits denials (RF18).
        expect(doc.permissions).toEqual(['clinical-notes:own']);
      }
    }
  });
});
