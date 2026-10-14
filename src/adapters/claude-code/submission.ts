// How a Claude Code session submits (D2). The session's structured output is an envelope that says `done`, with the
// step's output, or `blocked`, with a reason, so the agent can submit the outcome its prompt promises. The adapter reads
// the envelope back; the agent kind checks the output against the step's schema again, so nothing here validates it.
//
// STUB (TASK-002): signatures only, each returning a wrong value.

/** The text appended to the preset system prompt: how this harness takes a submission. */
export const SUBMIT_CONTRACT = '';

/**
 * The JSON Schema the session submits against: the envelope, with `schema` as its `output`. The step schema's own
 * definitions move to the envelope's root, so a `#/definitions/…` or `#/$defs/…` reference inside it still resolves.
 */
export function submissionEnvelope(outputSchema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...outputSchema };
}

/** What a submission said: done with its output, blocked with its reason, or why it can't be read. */
export type Submission =
  | { readonly outcome: 'done'; readonly output: unknown }
  | { readonly outcome: 'blocked'; readonly reason: string }
  | { readonly unreadable: string };

/** Reads the session's structured output back as a submission. */
export function readSubmission(_structured: unknown): Submission {
  return { unreadable: '' };
}
