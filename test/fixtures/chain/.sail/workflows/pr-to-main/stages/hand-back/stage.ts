// hand-back: gives the pull request back to a person. It stays open, with a comment that says why, its designation
// label swapped for sail-blocked so that no later poll lists it, and a comment on its ticket, whose state it leaves.
import { script, value, z } from 'sail';

export const HandedBack = z.object({ number: z.number().int(), labels: z.array(z.string()) });

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
