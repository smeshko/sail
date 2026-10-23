// commit-tests: commits the proven tests as tdd-plan's Step 7 does: the stubs, then the tests, fixtures and helpers,
// whose commit is the lock implement works against.
import { script, value } from 'sail';
import { CommitInfo, TestsCommitted } from '../../schemas';

export const commitTests = script('commit-tests', {
  run: './run.sh',
  consumes: { commit: value(CommitInfo) },
  output: TestsCommitted,
  // A commit that can't be made is an error, never a verdict.
  exitCodes: { passed: [0], failed: [] },
});
