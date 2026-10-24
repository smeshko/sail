// Whether a test run is the whole suite, and whether the whole suite may run here. scripts/test.ts refuses it outside
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

/** Whether `args` run every test: no path narrower than test/, and no name filter. */
export function wholeSuite(args: readonly string[]): boolean {
  const paths: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? '';
    if (arg === '-t' || arg.startsWith('--test-name-pattern')) return false;
    if (arg.startsWith('-')) {
      if (VALUED.has(arg)) at++;
      continue;
    }
    paths.push(arg);
  }
  return paths.every((path) => WHOLE.test(path));
}

/** Whether the whole suite may run here: on CI, or when SAIL_FULL_SUITE=1 asks for it. */
export function fullSuiteAllowed(env: Record<string, string | undefined>): boolean {
  return (env.CI !== undefined && env.CI !== '' && env.CI !== 'false') || env.SAIL_FULL_SUITE === '1';
}
