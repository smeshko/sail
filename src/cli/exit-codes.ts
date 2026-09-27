// The exit codes every sail command returns, from design.md §4.

/** 0: `completed`. The run completed, or the command succeeded. */
export const EXIT_OK = 0;

/** 1: `failed`. The stop reason is printed and in `summary.json`. */
export const EXIT_FAILED = 1;

/** 2: `suspended`. Resume with `sail resume <run>`, so usage errors never use it. */
export const EXIT_SUSPENDED = 2;

/**
 * 3: refused before the run started: config, credentials, type errors, no workflow, source not accepted, not designated
 * or already claimed, branch leased.
 */
export const EXIT_REFUSED = 3;

/** 4: internal: a bug in sail, not in the run. */
export const EXIT_INTERNAL = 4;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_FAILED
  | typeof EXIT_SUSPENDED
  | typeof EXIT_REFUSED
  | typeof EXIT_INTERNAL;
