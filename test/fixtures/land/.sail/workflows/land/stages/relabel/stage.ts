// relabel: takes the pull request's sail label off and puts sail-landed on.
import { script, value, z } from 'sail';

export const Relabelled = z.object({ number: z.number().int(), labels: z.array(z.string()) });

export const relabel = script('relabel', {
  run: './run.sh',
  ports: ['codehost'],
  consumes: { pr: value(z.number().int()) },
  output: Relabelled,
  exitCodes: { passed: [0], failed: [] },
});
