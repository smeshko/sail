// hand-back: gives the pull request back to a person. It stays open, with a comment that says why, its designation
// label swapped for sail-blocked so that no later poll lists it, and a comment on its ticket, whose state it leaves.
// When a person removed the label during the run, it only comments that the run didn't merge, as the stop stage does.
import { script, value, z } from 'sail';

/** `labelled: false` when the designation label was already gone: then nothing was handed back, and no label changed. */
export const HandedBack = z.object({ number: z.number().int(), labels: z.array(z.string()), labelled: z.boolean() });

export const handBack = script('hand-back', {
  run: './run.sh',
  consumes: {
    pr: value(z.number().int()),
    ticketKey: value(z.string()).optional(),
    reason: value(z.string()),
    details: value(z.string()),
  },
  output: HandedBack,
  // A port call that failed is an error, never a verdict: no exit code means failed.
  exitCodes: { passed: [0], failed: [] },
});
