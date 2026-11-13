import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, DependencyUnavailableError } from '@medicitas/kernel';

/**
 * Keycloak Admin REST client used by the orchestrators:
 * - client-credentials token of `medicitas-provisioner`, cached until 30 s before expiry;
 * - per-call timeout; bounded retry (0.5 s, 1.5 s, 4.5 s) ONLY for network errors, 429 and 5xx;
 * - any other 4xx is permanent (409 is returned to the caller, which reconciles by lookup);
 * - bodies, passwords and tokens are never logged or included in errors.
 */
export interface KeycloakAdminConfig {
  /** Internal base URL, e.g. http://keycloak:8080 */
  readonly baseUrl: string;
  readonly realm: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly timeoutMs?: number;
  readonly retryDelaysMs?: readonly number[];
}

export interface KeycloakUser {
  readonly id: string;
  readonly username: string;
  readonly enabled: boolean;
  readonly attributes: Readonly<Record<string, readonly string[]>>;
}

export interface KeycloakGroup {
  readonly id: string;
  readonly name: string;
  readonly attributes: Readonly<Record<string, readonly string[]>>;
}

interface RoleRepresentation {
  readonly id: string;
  readonly name: string;
}

/** A permanent Admin API answer (4xx other than 404/409 handled by the caller). */
export class KeycloakAdminError extends AppError {
  readonly status: number;

  constructor(status: number, operation: string) {
    super('dependency', 'IDENTITY_PROVIDER_REJECTED', `Keycloak rejected ${operation} (HTTP ${status}).`, { retryable: false });
    this.status = status;
  }
}

interface Response {
  readonly status: number;
  readonly location: string | null;
  readonly body: unknown;
}

const DEFAULT_RETRY_DELAYS = [500, 1_500, 4_500];

export class KeycloakAdminClient {
  private token: { readonly value: string; readonly expiresAt: number } | undefined;
  private readonly roles = new Map<string, RoleRepresentation>();

  constructor(private readonly config: KeycloakAdminConfig) {}

  private get adminBase(): string {
    return `${this.config.baseUrl}/admin/realms/${encodeURIComponent(this.config.realm)}`;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<globalThis.Response> {
    return fetch(url, { ...init, signal: AbortSignal.timeout(this.config.timeoutMs ?? 5_000) });
  }

  private async accessToken(): Promise<string> {
    if (this.token !== undefined && this.token.expiresAt > Date.now()) return this.token.value;
    const response = await this.fetchWithTimeout(`${this.config.baseUrl}/realms/${encodeURIComponent(this.config.realm)}/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.config.clientId, client_secret: this.config.clientSecret }),
    });
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) throw new Error(`token endpoint HTTP ${response.status}`);
      throw new KeycloakAdminError(response.status, 'the provisioner token request');
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('token endpoint returned no access token');
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 60;
    this.token = { value: body.access_token, expiresAt: Date.now() + Math.max(lifetime - 30, 5) * 1000 };
    return this.token.value;
  }

  /** One Admin API call with bounded retries; returns 2xx, 404 and 409 answers to the caller. */
  private async call(method: string, path: string, operation: string, body?: unknown): Promise<Response> {
    const delays = this.config.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
    for (let attempt = 0; ; attempt += 1) {
      let retryable = false;
      try {
        const response = await this.fetchWithTimeout(`${this.adminBase}${path}`, {
          method,
          headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.status === 401) this.token = undefined;
        if (response.ok || response.status === 404 || response.status === 409) {
          const text = await response.text();
          let parsed: unknown = null;
          if (text !== '') {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = null;
            }
          }
          return { status: response.status, location: response.headers.get('location'), body: parsed };
        }
        retryable = response.status === 401 || response.status === 429 || response.status >= 500;
        if (!retryable) throw new KeycloakAdminError(response.status, operation);
      } catch (error) {
        if (error instanceof KeycloakAdminError) throw error;
        retryable = true;
      }
      const delay = delays[attempt];
      if (!retryable || delay === undefined) throw new DependencyUnavailableError('identity provider');
      await sleep(delay);
    }
  }

  async findUserByUsername(username: string): Promise<KeycloakUser | null> {
    const response = await this.call('GET', `/users?exact=true&briefRepresentation=false&username=${encodeURIComponent(username)}`, 'user lookup');
    const users = Array.isArray(response.body) ? (response.body as KeycloakUser[]) : [];
    return users.find((user) => user.username.toLowerCase() === username.toLowerCase()) ?? null;
  }

  async getUser(id: string): Promise<KeycloakUser | null> {
    const response = await this.call('GET', `/users/${encodeURIComponent(id)}`, 'user read');
    return response.status === 404 ? null : (response.body as KeycloakUser);
  }

  /**
   * Creates a user with a TEMPORARY password (Keycloak forces UPDATE_PASSWORD at first login).
   * Returns null on 409 (already exists): the caller reconciles with an idempotent lookup.
   */
  async createUser(input: {
    readonly username: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly attributes: Readonly<Record<string, readonly string[]>>;
    readonly temporaryPassword: string;
  }): Promise<string | null> {
    const response = await this.call('POST', '/users', 'user creation', {
      username: input.username,
      email: input.username,
      emailVerified: true,
      firstName: input.firstName,
      lastName: input.lastName,
      enabled: true,
      attributes: input.attributes,
      credentials: [{ type: 'password', value: input.temporaryPassword, temporary: true }],
    });
    if (response.status === 409) return null;
    const id = response.location?.split('/').pop();
    if (id === undefined || id === '') throw new KeycloakAdminError(response.status, 'user creation (no Location)');
    return id;
  }

  async deleteUser(id: string): Promise<void> {
    await this.call('DELETE', `/users/${encodeURIComponent(id)}`, 'user deletion');
  }

  /** Read-modify-write, so a partial representation never drops attributes such as tenant_id. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const response = await this.call('GET', `/users/${encodeURIComponent(id)}`, 'user read');
    if (response.status === 404) return;
    const representation = { ...(response.body as Record<string, unknown>), enabled };
    await this.call('PUT', `/users/${encodeURIComponent(id)}`, 'user update', representation);
  }

  /** Revokes every session of the user (logical delete must take effect immediately). */
  async logout(id: string): Promise<void> {
    await this.call('POST', `/users/${encodeURIComponent(id)}/logout`, 'user logout');
  }

  private async role(name: string): Promise<RoleRepresentation> {
    const cached = this.roles.get(name);
    if (cached !== undefined) return cached;
    const response = await this.call('GET', `/roles/${encodeURIComponent(name)}`, 'role read');
    if (response.status !== 200) throw new KeycloakAdminError(response.status, `role ${name} read`);
    const role = response.body as RoleRepresentation;
    this.roles.set(name, role);
    return role;
  }

  async realmRolesOf(userId: string): Promise<readonly string[]> {
    const response = await this.call('GET', `/users/${encodeURIComponent(userId)}/role-mappings/realm`, 'role mapping read');
    return Array.isArray(response.body) ? (response.body as RoleRepresentation[]).map((role) => role.name) : [];
  }

  async addRealmRole(userId: string, name: string): Promise<void> {
    await this.call('POST', `/users/${encodeURIComponent(userId)}/role-mappings/realm`, 'role mapping', [await this.role(name)]);
  }

  async removeRealmRole(userId: string, name: string): Promise<void> {
    await this.call('DELETE', `/users/${encodeURIComponent(userId)}/role-mappings/realm`, 'role unmapping', [await this.role(name)]);
  }

  async groupByPath(path: string): Promise<KeycloakGroup | null> {
    const response = await this.call('GET', `/group-by-path/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`, 'group lookup');
    return response.status === 404 ? null : (response.body as KeycloakGroup);
  }

  /** Creates a sub-group; returns null on 409 (already exists) so the caller reconciles by path. */
  async createChildGroup(parentId: string, name: string, attributes: Readonly<Record<string, readonly string[]>>): Promise<string | null> {
    const response = await this.call('POST', `/groups/${encodeURIComponent(parentId)}/children`, 'group creation', { name, attributes });
    if (response.status === 409) return null;
    const id = response.location?.split('/').pop() ?? (response.body as { id?: string } | null)?.id;
    if (id === undefined || id === '') throw new KeycloakAdminError(response.status, 'group creation (no id)');
    return id;
  }

  async deleteGroup(id: string): Promise<void> {
    await this.call('DELETE', `/groups/${encodeURIComponent(id)}`, 'group deletion');
  }

  async addUserToGroup(userId: string, groupId: string): Promise<void> {
    await this.call('PUT', `/users/${encodeURIComponent(userId)}/groups/${encodeURIComponent(groupId)}`, 'group membership');
  }

  /** Groups whose attribute `name` equals `value` (organizational lookup of a tenant group). */
  async groupsByAttribute(name: string, value: string): Promise<readonly KeycloakGroup[]> {
    const response = await this.call('GET', `/groups?briefRepresentation=false&populateHierarchy=false&q=${encodeURIComponent(`${name}:${value}`)}`, 'group search');
    const flatten = (groups: readonly (KeycloakGroup & { subGroups?: KeycloakGroup[] })[]): KeycloakGroup[] =>
      groups.flatMap((group) => [group, ...flatten(group.subGroups ?? [])]);
    return Array.isArray(response.body)
      ? flatten(response.body as (KeycloakGroup & { subGroups?: KeycloakGroup[] })[]).filter((group) => group.attributes?.[name]?.includes(value) === true)
      : [];
  }
}
