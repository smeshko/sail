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
];
export const GATE_DIRS = ['.github/'];

export function isGateFile(path) {
  return (
    GATE_FILES.includes(path) ||
    GATE_DIRS.some((dir) => path.startsWith(dir)) ||
    ['.gitignore', 'biome.json', 'biome.jsonc'].includes(path.split('/').at(-1))
  );
}
