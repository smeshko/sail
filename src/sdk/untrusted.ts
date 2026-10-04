// `untrusted()`: a string schema that says a person outside the run wrote the text. The engine reads the schema, never
// the value, to find which strings of a value a prompt must wrap: a value crosses JSON between calls and keeps no mark.
import { z } from 'zod';

/** One check object on every untrusted string. Each clone of a schema, as `.max()` makes, copies its checks. */
const MARK = z.check(() => {});

/** A string a person outside the run wrote, such as a ticket's title. */
export function untrusted() {
  return z.string().check(MARK).brand<'untrusted'>();
}

/** The output type of `untrusted()`: still a string wherever one is expected. */
export type Untrusted = z.infer<ReturnType<typeof untrusted>>;

/** Whether `schema` is a string schema that carries the mark. */
export function isUntrusted(schema: z.ZodType): boolean {
  const def = schema.def as { type: string; checks?: unknown[] };
  return def.type === 'string' && def.checks?.includes(MARK) === true;
}
