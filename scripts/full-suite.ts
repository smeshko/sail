// Whether a test run is the whole suite or broad, and whether the whole suite may run here. scripts/test.ts refuses it outside
// CI: it is the verify check of every pull request, and takes about ten minutes there, longer on a laptop.

/** The `bun test` options that take their value as the next argument. */
const VALUED = new Set([
  '--timeout',
  '-t',
  '--test-name-pattern',
  '--reporter',
  '--reporter-outfile',
  '--coverage-reporter',
  '--coverage-dir',
  '--preload',
  '--rerun-each',
  '--seed',
  '--path-ignore-patterns',
  '--max-concurrency',
]);
const WHOLE = /^(\.\/?|(\.\/)?test\/?)$/;

/** The path arguments of `args`, skipping options and their values, and whether a test name filter is given. */
function paths(args: readonly string[]): { paths: string[]; named: boolean } {
  const found: string[] = [];
  let named = false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? '';
    if (arg === '-t' || arg.startsWith('--test-name-pattern')) named = true;
    if (arg.startsWith('-')) {
      if (VALUED.has(arg)) at++;
      continue;
    }
    found.push(arg);
  }
  return { paths: found, named };
}

/** Whether `args` run every test: no path narrower than test/, and no name filter. */
export function wholeSuite(args: readonly string[]): boolean {
  const { paths: found, named } = paths(args);
  return !named && found.every((path) => WHOLE.test(path));
}

/** The most test files a run may name and still count as narrow. */
export const BROAD_FILES = 5;

/** Whether `args` run many tests: no path, a folder or filter rather than a file, or more than BROAD_FILES files. */
export function broadRun(args: readonly string[]): boolean {
  const { paths: found } = paths(args);
  return found.length === 0 || found.length > BROAD_FILES || found.some((path) => !path.endsWith('.test.ts'));
}

/** Whether the whole suite may run here: on CI, or when SAIL_FULL_SUITE=1 asks for it. */
export function fullSuiteAllowed(env: Record<string, string | undefined>): boolean {
  return (env.CI !== undefined && env.CI !== '' && env.CI !== 'false') || env.SAIL_FULL_SUITE === '1';
}
