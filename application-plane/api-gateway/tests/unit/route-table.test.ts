import { describe, expect, it } from 'vitest';
import { ROUTES, matchRoute } from '../../src/domain/route-table.js';

const id = '42000000-0000-4000-8000-000000010001';

describe('gateway routing table', () => {
  it('routes professional sub-resources to the scheduler and the rest to catalog', () => {
    expect(matchRoute('GET', `/api/v1/professionals/${id}`)).toMatchObject({ kind: 'found', route: { upstream: 'catalog-service-management' } });
    expect(matchRoute('PUT', `/api/v1/professionals/${id}/services`)).toMatchObject({ route: { upstream: 'catalog-service-management' } });
    expect(matchRoute('PUT', `/api/v1/professionals/${id}/weekly-schedule`)).toMatchObject({ route: { upstream: 'scheduler-management' } });
    expect(matchRoute('DELETE', `/api/v1/professionals/${id}/calendar-blocks/${id}`)).toMatchObject({ route: { upstream: 'scheduler-management' } });
  });

  it('routes patient history to the scheduler and patients to user-management', () => {
    expect(matchRoute('GET', `/api/v1/patients/${id}/appointments`)).toMatchObject({ route: { upstream: 'scheduler-management' } });
    expect(matchRoute('GET', `/api/v1/patients/${id}`)).toMatchObject({ route: { upstream: 'user-management' } });
    expect(matchRoute('GET', '/api/v1/availability/search')).toMatchObject({ route: { upstream: 'scheduler-management' } });
  });

  it('distinguishes unknown routes (404) from known paths with another method (405)', () => {
    expect(matchRoute('GET', '/api/v1/nope').kind).toBe('not-found');
    expect(matchRoute('DELETE', '/api/v1/patients')).toEqual({ kind: 'method-not-allowed', allowed: ['POST', 'GET'] });
    expect(matchRoute('GET', `/api/v1/patients/${id}/appointments/extra`).kind).toBe('not-found');
  });

  it('has exactly one definition per method and template', () => {
    const keys = ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ROUTES).toHaveLength(47);
  });
});
