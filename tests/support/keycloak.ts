import { env } from './env.js';

export function keycloakBase(): string {
  return env('KEYCLOAK_PUBLIC_URL');
}

export function realmUrl(): string {
  return `${keycloakBase()}/realms/medicitas`;
}

/** Obtains an access token from Keycloak (MediCitas never issues tokens itself). */
export async function passwordGrant(username: string, password: string): Promise<string> {
  const response = await fetch(`${realmUrl()}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'medicitas-cli', username, password }),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!response.ok || body.access_token === undefined) {
    throw new Error(`token request for ${username} failed with HTTP ${response.status}`);
  }
  return body.access_token;
}

export function demoPassword(): string {
  return env('MEDICITAS_DEMO_USER_PASSWORD');
}

export async function provisionerToken(): Promise<string> {
  const response = await fetch(`${realmUrl()}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'medicitas-provisioner',
      client_secret: env('MEDICITAS_PROVISIONER_CLIENT_SECRET'),
    }),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!response.ok || body.access_token === undefined) throw new Error(`provisioner token failed: ${response.status}`);
  return body.access_token;
}

export function decodePayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}
