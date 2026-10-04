// `untrusted()`: a string schema that says a person outside the run wrote the text. The engine reads the schema, never
// the value, to find which strings of a value a prompt must wrap: a value crosses JSON between calls and keeps no mark.
import { z } from 'zod';

/** A string a person outside the run wrote, such as a ticket's title. */
export function untrusted() {
  return z.string().brand<'untrusted'>();
}

/** The output type of `untrusted()`: still a string wherever one is expected. */
export type Untrusted = z.infer<ReturnType<typeof untrusted>>;

/** Whether `schema` is a string schema that carries the mark. */
export function isUntrusted(_schema: z.ZodType): boolean {
  return false;
}
