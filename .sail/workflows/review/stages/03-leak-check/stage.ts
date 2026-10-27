// leak-check: the public repository's rule, checked without judgment. It scans the lines the pull request adds for a
// tracker key other than sail's own and for each term of a private denylist kept outside git, and reports every hit.
// It judges nothing: each hit reaches the judge as a finding.
import { file, script, z } from 'sail';

export const Leaks = z.object({
  hits: z.array(
    z.object({ file: z.string(), line: z.number().int(), match: z.string(), kind: z.enum(['key', 'denylist']) }),
  ),
  /** Where the denylist was read from, or null when there is none and only tracker keys were scanned for. */
  denylist: z.string().nullable(),
});

export const leakCheck = script('leak-check', {
  run: './run.sh',
  consumes: { diff: file('diff.patch') },
  output: Leaks,
  exitCodes: { passed: [0], failed: [] },
  network: 'none',
});
