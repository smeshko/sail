// scripts/test.ts runs the tests in a throwaway HOME, and refuses the whole suite outside CI: it takes about ten
// minutes, and CI's verify runs it on every pull request.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fullSuiteAllowed, wholeSuite } from '../../scripts/test';

const LAUNCHER = join(import.meta.dir, '..', '..', 'scripts', 'test.ts');

test('a run with no path, or one no narrower than test/, is the whole suite', () => {
  for (const args of [[], ['--coverage'], ['--timeout', '60000', './test'], ['test'], ['test/'], ['.'], ['./']]) {
    expect({ args, whole: wholeSuite(args) }).toEqual({ args, whole: true });
  }
});

test('a file, a folder under test/ or a name filter narrows the run, and a flag value is no path', () => {
  for (const args of [
    ['./test/cli/port.test.ts'],
    ['test/cli'],
    ['show'],
    ['--timeout', '60000', './test/isolation.test.ts'],
    ['-t', 'prints the total'],
    ['--test-name-pattern=prints the total'],
  ]) {
    expect({ args, whole: wholeSuite(args) }).toEqual({ args, whole: false });
  }
  expect(wholeSuite(['--timeout', 'test/cli'])).toBe(true);
});

test('the whole suite is allowed on CI, or with SAIL_FULL_SUITE=1, and nowhere else', () => {
  expect(fullSuiteAllowed({ CI: 'true' })).toBe(true);
  expect(fullSuiteAllowed({ SAIL_FULL_SUITE: '1' })).toBe(true);
  expect(fullSuiteAllowed({})).toBe(false);
  expect(fullSuiteAllowed({ CI: '' })).toBe(false);
  expect(fullSuiteAllowed({ CI: 'false', SAIL_FULL_SUITE: '0' })).toBe(false);
});

test('outside CI the launcher refuses the whole suite with exit 2, saying how to run less, before any test runs', () => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'CI' && key !== 'SAIL_FULL_SUITE') env[key] = value;
  }
  const result = Bun.spawnSync([process.execPath, LAUNCHER, '--coverage'], { env });
  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString()).toBe('');
  expect(result.stderr.toString()).toBe(
    'scripts/test.ts: the whole suite runs on CI, as the verify check of every pull request. ' +
      'Locally, run test files or folders by name (bun run test ./test/cli/port.test.ts), ' +
      'or bun run gate for the ones your branch affects. SAIL_FULL_SUITE=1 runs it here anyway.\n',
  );
});
