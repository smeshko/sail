// The submit contract's envelope: the SDK's structured output is a `done` or a `blocked` branch around the step's own
// schema. STUB (TASK-004): the signatures are final, the bodies are not.

/** The two ways a session submits, as the envelope unwraps them. */
export type Submission =
  | { readonly outcome: 'done'; readonly output: unknown }
  | { readonly outcome: 'blocked'; readonly reason: string };

/** The draft-07 JSON Schema the SDK receives as `outputFormat.schema`. Stub: an open schema. */
export function submissionSchema(_outputSchema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {};
}

/** What a structured output submitted, or nothing when it is not a well-formed envelope. Stub: nothing. */
export function unwrap(_envelope: unknown): Submission | undefined {
  return undefined;
}
