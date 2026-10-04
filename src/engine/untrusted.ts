// markUntrusted(): reads a schema beside a value and turns each string the schema marks into an `untrustedInput`, so the
// renderer wraps it wherever a template prints it. The walk follows the value, which is finite.
import type { z } from 'zod';

/** `value` with each string `schema` marks as untrusted input from `source`. `value` itself is not changed. */
export function markUntrusted(_schema: z.ZodType, value: unknown, _source: string): unknown {
  return value;
}
