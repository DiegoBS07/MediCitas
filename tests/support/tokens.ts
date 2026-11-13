import { demoPassword, passwordGrant } from './keycloak.js';
import { env } from './env.js';

/** Seeded logins (docs/data/seed-data.md). */
export const USERS = {
  platformAdmin: 'platform.admin@medicitas.test',
  clinic1Admin: 'ana.mora@sanjose.medicitas.test',
  clinic1Receptionist: 'carlos.jimenez@sanjose.medicitas.test',
  clinic1Receptionist2: 'laura.vargas@sanjose.medicitas.test',
  clinic1Professional1: 'andres.rojas@sanjose.medicitas.test',
  clinic1Professional2: 'sofia.castro@sanjose.medicitas.test',
  clinic1Professional3: 'javier.mendez@sanjose.medicitas.test',
  clinic2Admin: 'mariela.quesada@heredia.medicitas.test',
  clinic2Receptionist: 'diego.araya@heredia.medicitas.test',
} as const;

const cache = new Map<string, { readonly token: string; readonly expiresAt: number }>();

/** Access token of a seeded user (cached for 4 minutes; tokens live 5). */
export async function tokenOf(user: keyof typeof USERS): Promise<string> {
  const cached = cache.get(user);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.token;
  const password = user === 'platformAdmin' ? env('MEDICITAS_PLATFORM_ADMIN_PASSWORD') : demoPassword();
  const token = await passwordGrant(USERS[user], password);
  cache.set(user, { token, expiresAt: Date.now() + 4 * 60_000 });
  return token;
}
