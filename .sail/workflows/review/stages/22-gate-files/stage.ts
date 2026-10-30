// gate-files reports the gate files a pull request changes; the workflow decides whether to hand it to a human.
import { script, value, z } from 'sail';
import { PullRequestRef } from '../../../../stages/file-follow-ups/stage';

export const GateFiles = z.object({ base: z.string(), touched: z.array(z.string()) });

export const gateFiles = script('gate-files', {
  run: './run.sh',
  ports: ['codehost'],
  consumes: { pr: value(PullRequestRef), headSha: value(z.string()) },
  output: GateFiles,
  exitCodes: { passed: [0], failed: [] },
});
