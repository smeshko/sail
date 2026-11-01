// The gate files: what `bun run verify` reads, so a pull request changing one could loosen its own check. Keep this
// literal beside EVERYTHING in scripts/affected-tests.ts and .github/workflows/verify.yml.
export const GATE_FILES = [
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'tsconfig.json',
  'scripts/test.ts',
  'test/setup.ts',
  'test/coverage-census.test.ts',
  'biome.json',
  'scripts/full-suite.ts',
  'scripts/bun-version.ts',
  'scripts/test-watchdog.ts',
];
export const GATE_DIRS = ['.github/'];

// The review judges a pull request by the guard its run loaded, so one changing the guard or the merge path would be
// judged by the guard it replaces. A stage added to the merge path must be added here.
export const GUARD_FILES = ['.sail/lib/gate-files.mjs', '.sail/workflows/review/workflow.ts'];
export const GUARD_DIRS = [
  '.sail/workflows/review/stages/18-merge/',
  '.sail/workflows/review/stages/21-hand-over/',
  '.sail/workflows/review/stages/22-gate-files/',
];

export function isGateFile(path) {
  return (
    GATE_FILES.includes(path) ||
    GATE_DIRS.some((dir) => path.startsWith(dir)) ||
    GUARD_FILES.includes(path) ||
    GUARD_DIRS.some((dir) => path.startsWith(dir)) ||
    ['.gitignore', 'biome.json', 'biome.jsonc'].includes(path.split('/').at(-1))
  );
}
