// hand-over: moves the ticket to in review, and comments the pull request's link on it.
import { script, value, z } from 'sail';

export const HandedOver = z.object({ state: z.object({ type: z.string(), name: z.string() }) });

export const handOver = script('hand-over', {
  run: './run.sh',
  consumes: { ticketKey: value(z.string()), url: value(z.string()) },
  output: HandedOver,
  exitCodes: { passed: [0], failed: [] },
});
