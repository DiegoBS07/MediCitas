import { z } from 'zod';
import { ValidationError, type ErrorDetail } from '@medicitas/kernel';

export type InputSource = 'body' | 'query' | 'params' | 'header';

/** Parses request input with a zod schema; failures become 400 VALIDATION_FAILED with per-field details. */
export function parseInput<Schema extends z.ZodType>(schema: Schema, value: unknown, source: InputSource): z.infer<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details: ErrorDetail[] = result.error.issues.slice(0, 20).map((issue) => ({
    path: [source, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
  throw new ValidationError('The request is invalid.', details);
}

/** Canonical lowercase UUID (path and body identifiers). */
export const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'must be a canonical lowercase UUID');

/** RFC 3339 instant with an explicit offset (naive local timestamps are rejected; api-contracts §1.1). */
export const instantSchema = z.iso.datetime({ offset: true, local: false });

/** Local calendar date YYYY-MM-DD (validated as a real date). */
export const localDateSchema = z.iso.date();

/** Local time HH:mm. */
export const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:mm');

export function pathParams<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object(shape).strict();
}
