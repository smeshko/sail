// Generated from src/sdk by `bun run types`. Do not edit.
import { z } from 'zod';
/** A string a person outside the run wrote, such as a ticket's title. */
export declare function untrusted(): z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
/** The output type of `untrusted()`: still a string wherever one is expected. */
export type Untrusted = z.infer<ReturnType<typeof untrusted>>;
/** Whether `schema` is a string schema that carries the mark. */
export declare function isUntrusted(_schema: z.ZodType): boolean;
