// Merges the current base of the pull request in $INPUT_PR into the workspace's branch, so a merge the host rejected
// for a conflict can be tried again. The base is fetched from `origin` when the workspace has one, since the host's
// base sha can lag behind its branch; without one, the host's base sha is the base. A base the branch already holds
// is nothing to do. A conflicting merge is left in progress, its conflicted paths named, for resolve-conflicts to
// finish. A push never forces, so the branch takes a merge commit, never a rebase. Prints the Synced.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(process.env[name], 'utf8');
const pr = JSON.parse(read('INPUT_PR'));
const ticketKey = process.env.INPUT_TICKETKEY ? read('INPUT_TICKETKEY').trim() : '';

/** Runs git in the workspace: its exit code and trimmed stdout. */
function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.stderr) process.stderr.write(result.stderr);
  return { code: result.status, out: (result.stdout ?? '').trim() };
}

const got = spawnSync('sail', ['port', 'codehost', 'get-pull-request', String(pr.number)], { encoding: 'utf8' });
if (got.status !== 0) throw new Error(`get-pull-request: ${got.stderr.trim()}`);
const details = JSON.parse(got.stdout.trim().split('\n').at(-1));
let baseSha = details.baseSha;
if (git('remote', 'get-url', 'origin').code === 0) {
  if (git('fetch', 'origin', `refs/heads/${details.base}`).code !== 0)
    throw new Error(`fetching ${details.base} failed`);
  baseSha = git('rev-parse', 'FETCH_HEAD').out;
}

const synced = { moved: false, baseSha, conflicts: [] };
if (git('merge-base', '--is-ancestor', baseSha, 'HEAD').code !== 0) {
  synced.moved = true;
  const message = `Merge ${details.base} into the pull request${ticketKey ? ` (${ticketKey})` : ''}`;
  if (git('merge', '--no-ff', '--no-edit', '-m', message, baseSha).code !== 0) {
    synced.conflicts = git('diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
    if (synced.conflicts.length === 0) throw new Error(`merging ${baseSha} failed with no conflicted path`);
  }
}
console.log(JSON.stringify(synced));
