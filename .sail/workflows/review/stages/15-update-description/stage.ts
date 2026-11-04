// update-description: rewrites the pull request's description through the code host, for a finding about it. The fix
// agent edits the text and cannot call the port itself, so this script stage sends it.
import { script, value, z } from 'sail';

export const UpdatedDescription = z.object({ body: z.string() });

export const updateDescription = script('update-description', {
  run: './run.sh',
  ports: ['codehost'],
  consumes: { pr: value(z.number().int()), body: value(z.string()) },
  output: UpdatedDescription,
  exitCodes: { passed: [0], failed: [] },
});
