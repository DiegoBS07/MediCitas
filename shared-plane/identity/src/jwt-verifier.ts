import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { AuthenticationError, DependencyUnavailableError } from '@medicitas/kernel';
import { buildTenantContext, type TenantContext } from './tenant-context.js';

export interface JwtVerifierConfig {
  /** Internal JWKS URL, e.g. http://keycloak:8080/realms/medicitas/protocol/openid-connect/certs */
  readonly jwksUrl: string;
  /** Public issuer that Keycloak writes in tokens, e.g. http://localhost:8080/realms/medicitas */
  readonly issuer: string;
  /** Required audience (ADR-0005): medicitas-api */
  readonly audience: string;
  readonly clockToleranceSeconds?: number;
  readonly jwksTimeoutMs?: number;
}

export interface JwtVerifier {
  /** Verifies an `Authorization` header value and builds the TenantContext (401 on any failure). */
  verifyAuthorizationHeader(header: string | undefined, correlationId: string): Promise<TenantContext>;
  verifyToken(token: string, correlationId: string): Promise<TenantContext>;
}

const BEARER = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/;

/**
 * Signature validation against the Keycloak JWKS (RS256 only). Keys are cached and refreshed
 * automatically when an unknown `kid` appears (key rotation). MediCitas never issues tokens.
 */
export function createJwtVerifier(config: JwtVerifierConfig): JwtVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl), {
    timeoutDuration: config.jwksTimeoutMs ?? 3_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });

  async function verifyToken(token: string, correlationId: string): Promise<TenantContext> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
        clockTolerance: config.clockToleranceSeconds ?? 30,
        requiredClaims: ['exp', 'iat', 'sub'],
      });
      payload = result.payload;
    } catch (error) {
      if (isJwksUnavailable(error)) {
        // The identity provider cannot be reached and the key is not cached: a dependency issue, not a bad token.
        throw new DependencyUnavailableError('identity provider', error);
      }
      throw new AuthenticationError('TOKEN_INVALID', 'Access token rejected.', error);
    }
    return buildTenantContext(payload, correlationId);
  }

  return {
    verifyToken,
    async verifyAuthorizationHeader(header, correlationId) {
      if (header === undefined || header.trim() === '') {
        throw new AuthenticationError('AUTHENTICATION_REQUIRED', 'A bearer access token is required.');
      }
      const match = BEARER.exec(header.trim());
      if (match === null || match[1] === undefined) {
        throw new AuthenticationError('TOKEN_INVALID', 'Malformed Authorization header.');
      }
      return verifyToken(match[1], correlationId);
    },
  };
}

function isJwksUnavailable(error: unknown): boolean {
  if (error instanceof joseErrors.JWKSTimeout) return true;
  // createRemoteJWKSet surfaces network failures as plain errors (fetch failed / ECONNREFUSED).
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true;
  return false;
}
