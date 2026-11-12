// The gate files: what `bun run verify` reads, so a pull request changing one could loosen its own check. Keep this
// literal beside EVERYTHING in scripts/affected-tests.ts and .github/workflows/verify.yml. The config and its
// workspace setup script at the end are not read by verify: they are here because they load code into the review run.
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
  'scripts/test-running.ts',
  // The config, whose adapters and workspace setup load code into the review run, and the script that setup runs.
  '.sail/project.yaml',
  'scripts/workspace-docs.ts',
];
export const GATE_DIRS = ['.github/'];

// The review judges a pull request by the guard its run loaded, so one changing the guard or the merge path would be
// judged by the guard it replaces. So every module the guard and the merge path import, and every script their stages
// run, must be covered too. A module or stage added to that graph must be covered here; test/sail/gate-files.test.ts
// derives the graph and fails when one isn't.
export const GUARD_FILES = [
  '.sail/lib/gate-files.mjs',
  '.sail/lib/permissions.ts',
  '.sail/lib/jev-check.mjs',
  '.sail/lib/duplicates.mjs',
  '.sail/lib/gate-lock.mjs',
  '.sail/lib/test-failures.mjs',
  '.sail/lib/play.sh',
  '.sail/lib/play.mjs',
  '.sail/workflows/review/workflow.ts',
];
// Every file in these folders but a `.md` prompt or template.
export const GUARD_CODE_DIRS = ['.sail/workflows/review/', '.sail/stages/file-follow-ups/', '.sail/stages/validate/'];
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
    (GUARD_CODE_DIRS.some((dir) => path.startsWith(dir)) && !path.endsWith('.md')) ||
    ['.gitignore', 'biome.json', 'biome.jsonc'].includes(path.split('/').at(-1))
  );
}
