// leak-check: exact matches and Jev judgments about the public repository's naming rule. It scans added lines for
// tracker keys other than sail's own and terms of a private denylist kept outside git, and reports every exact hit.
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
  ports: ['jev'],
  consumes: { diff: file('diff.patch'), base: value(z.string()) },
  output: Leaks,
  exitCodes: { passed: [0], failed: [] },
});
