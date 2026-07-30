import { randomUUID } from 'crypto';

/**
 * Primary-key generator. Every id column in the Phase-248 schema is `UUID`, so this
 * must return a canonical UUID string — a non-UUID would be rejected by Postgres.
 */
export function generateId(): string {
  return randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Returns the distinct members of `values`, preserving first-seen order. */
export function distinct<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
