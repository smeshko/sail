// prove-tests: proves the pending tests write-tests left, as tdd-plan's Steps 5 and 6 do. With their stickers they
// build, lint and skip; without them every one fails on its assertion. The red failures are the evidence implement
// reproduces.
import { script, value } from 'sail';
import { Proof, TestsWritten } from '../../schemas';

export const proveTests = script('prove-tests', {
  run: './run.sh',
  consumes: { written: value(TestsWritten) },
  produces: { 'red.txt': 'file' },
  output: Proof,
  timeoutSeconds: 1200,
});
