// leak-check: the public repository's rule, checked without judgment. It scans the lines the pull request adds for a
// tracker key other than sail's own and for each term of a private denylist kept outside git, and reports every hit.
// Jev also checks added comment, doc and commit-message lines; each hit reaches the judge as a finding.
import { file, script, value, z } from 'sail';

export const Leaks = z.object({
  hits: z.array(
    z.object({
      file: z.string(),
      line: z.number().int(),
      match: z.string(),
      kind: z.enum(['key', 'denylist', 'jev']),
      yes: z.number().optional(),
    }),
  ),
  /** Where the denylist was read from, or null when there is none and only tracker keys were scanned for. */
  denylist: z.string().nullable(),
  jev: z.object({ asked: z.boolean(), note: z.string(), threshold: z.number(), lines: z.number() }),
});

export const leakCheck = script('leak-check', {
  run: './run.sh',
  consumes: { diff: file('diff.patch'), base: value(z.string()) },
  output: Leaks,
  exitCodes: { passed: [0], failed: [] },
});
