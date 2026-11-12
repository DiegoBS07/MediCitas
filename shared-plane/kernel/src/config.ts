import type { z } from 'zod';

/** Thrown when the process configuration is invalid. Lists variable names only, never values. */
export class ConfigurationError extends Error {
  readonly invalidKeys: readonly string[];

  constructor(invalidKeys: readonly string[]) {
    super(`Invalid or missing configuration: ${invalidKeys.join(', ')}`);
    this.name = 'ConfigurationError';
    this.invalidKeys = invalidKeys;
  }
}

/**
 * Parses environment variables with a zod schema and fails fast at startup.
 * Error messages contain variable names only, so secrets never reach the logs.
 */
export function parseConfig<Schema extends z.ZodType>(
  schema: Schema,
  env: Readonly<Record<string, string | undefined>> = process.env,
): z.infer<Schema> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(root)'))];
    throw new ConfigurationError(keys);
  }
  return result.data;
}
