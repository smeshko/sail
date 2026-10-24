// file-follow-ups: files each follow-up as a ticket of its own through `sail port ticket-source create`, then lists the
// tickets on the pull request. It runs once the pull request is open, so a ticket that can't be filed is reported, not
// fatal.
import { script, value, z } from 'sail';
import { FollowUps } from '../../schemas';
import { PrInfo } from '../08-open/stage';

export const Filed = z.object({
  filed: z.array(z.object({ title: z.string(), ticketKey: z.string(), url: z.string() })),
  failed: z.array(z.object({ title: z.string(), error: z.string() })),
});

export const fileFollowUps = script('file-follow-ups', {
  run: './run.sh',
  consumes: { followUps: value(FollowUps), pr: value(PrInfo), ticketKey: value(z.string()) },
  output: Filed,
  exitCodes: { passed: [0], failed: [] },
});
