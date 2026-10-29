// Keep this literal beside EVERYTHING in scripts/affected-tests.ts and .github/workflows/verify.yml.
// Never import it from the pull request's editable workspace: the stage runs from the frozen definition.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.stderr) process.stderr.write(result.stderr);
  return { code: result.status, out: result.stdout ?? '' };
}

if (process.env.INPUT_PR) {
  const pr = JSON.parse(readFileSync(process.env.INPUT_PR, 'utf8'));
  const headSha = readFileSync(process.env.INPUT_HEADSHA, 'utf8').trim();
  const got = spawnSync('sail', ['port', 'codehost', 'get-pull-request', String(pr.number)], { encoding: 'utf8' });
  if (got.status !== 0) throw new Error(`get-pull-request: ${got.stderr.trim()}`);
  const details = JSON.parse(got.stdout.trim().split('\n').at(-1));
  let base = details.baseSha;
  if (git('remote', 'get-url', 'origin').code === 0) {
    if (git('fetch', 'origin', `refs/heads/${details.base}`).code !== 0)
      throw new Error(`fetching ${details.base} failed`);
    const fetched = git('rev-parse', 'FETCH_HEAD');
    if (fetched.code !== 0) throw new Error('resolving FETCH_HEAD failed');
    base = fetched.out.trim();
  }
  const diff = git('diff', '-z', '--name-only', '--no-renames', `${base}...${headSha}`);
  if (diff.code !== 0) throw new Error('diffing the pull request failed');
  const touched = diff.out.split('\0').filter(isGateFile);
  console.error(`gate files: ${touched.length}`);
  console.log(JSON.stringify({ base, touched }));
}
