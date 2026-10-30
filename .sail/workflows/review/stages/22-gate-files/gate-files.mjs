// Names the gate files the pull request's head changes against its current base. The gate list comes from the run's
// own `.sail/lib`, beside `$SAIL_CONFIG`, never from the pull request's editable workspace.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const { isGateFile } = await import(join(dirname(process.env.SAIL_CONFIG), 'lib', 'gate-files.mjs'));

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.stderr) process.stderr.write(result.stderr);
  return { code: result.status, out: result.stdout ?? '' };
}

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
