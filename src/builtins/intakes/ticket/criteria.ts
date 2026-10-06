// splitDescription(): a ticket's description split into the request and its acceptance criteria, the list under an
// "Acceptance criteria" heading. Only what became a criterion leaves the request, so no line of a description is lost.
// A pure function: this module imports nothing.

export interface SplitDescription {
  /** The description without the heading and the criteria's lines. */
  request: string;
  /** Each top-level list item of the section, in order, without its marker or checkbox. */
  criteria: string[];
}

/** Splits `description` into the request and the acceptance criteria it lists. */
export function splitDescription(_description: string): SplitDescription {
  return { request: 'stub', criteria: ['stub'] };
}
