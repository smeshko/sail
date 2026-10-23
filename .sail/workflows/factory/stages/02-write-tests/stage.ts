// write-tests: writes every test the plan needs, and the stubs they call, before any implementation exists, as
// tdd-plan does. The tests stay pending behind their stickers; prove-tests proves them, and commit-tests commits them.
import { agent, file, value } from 'sail';
import { Proof, TestsWritten } from '../../schemas';

export const writeTests = agent('write-tests', {
  prompt: './prompt.md',
  consumes: { plan: file('plan.md'), feedback: value(Proof).optional() },
  output: TestsWritten,
  model: 'deep',
  permissions: {
    read: ['**'],
    write: ['src/**', 'test/**', 'types/**', 'schemas/**', '$STAGE_OUT/**'],
    commands: [
      'bun run test *',
      'bun run typecheck',
      'bun run lint',
      'bun run fix',
      'bun run types',
      'git diff *',
      'git status *',
      'git log *',
      'git show *',
      'git grep *',
    ],
  },
  budget: { maxTurns: 150, maxUsd: 6, maxMinutes: 30 },
});
