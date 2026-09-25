import { homedir } from 'node:os';

// Preload guard: only scripts/test.ts starts Bun with an isolated HOME, and Bun can't be isolated after startup.
const testHome = process.env.SAIL_TEST_HOME;
if (!testHome || testHome !== homedir()) {
  console.error('sail: run tests with `bun run test` (plain `bun test` would use your real HOME)');
  process.exit(2);
}
