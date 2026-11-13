import { BusinessRuleError, ValidationError } from '@medicitas/kernel';

/** Slug rule shared with the database CHECK tenants_slug_format and the REST contract. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export function assertSlug(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new ValidationError('Invalid tenant slug.', [{ path: 'slug', message: 'must match ^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$' }]);
  }
  return slug;
}

/**
 * IANA timezone check with the runtime's ICU data. PostgreSQL re-checks against pg_timezone_names
 * (trigger tenants_validate_timezone), which stays the final authority.
 */
export function assertTimezone(timezone: string): string {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(timezone) || timezone === 'Local') throw invalidTimezone(timezone);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw invalidTimezone(timezone);
  }
  return timezone;
}

export function invalidTimezone(timezone: string): BusinessRuleError {
  return new BusinessRuleError('INVALID_TIMEZONE', `"${timezone.slice(0, 64)}" is not a valid IANA timezone.`);
}

export function assertTenantName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 120) {
    throw new ValidationError('Invalid tenant name.', [{ path: 'name', message: 'must have 2 to 120 characters' }]);
  }
  return trimmed;
}
