// Validates the branch in the workspace and prints the Validation: what is uncommitted, how the tests differ from their
// lock, and how `bun run verify` ended.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, tail } from '../../../../lib/stickers.mjs';

const root = process.cwd();
const bun = process.env.SAIL_BUN ?? 'bun';
const { testsCommit } = JSON.parse(readFileSync(process.env.INPUT_LOCK, 'utf8'));

const uncommitted = git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
  .stdout.split('\n')
  .filter(Boolean)
  .map((line) => line.slice(3));

let violations = [];
let amendments = [];
if (testsCommit !== null) {
  const checker = join(process.env.SAIL_CONFIG, '..', 'lib', 'check-tests.mjs');
  const checked = spawnSync(bun, [checker, testsCommit], { cwd: root, encoding: 'utf8' });
  if (checked.status !== 0) violations = [`check-tests failed: ${checked.stderr.trim()}`];
  else ({ violations, amendments } = JSON.parse(checked.stdout.trim().split('\n').at(-1)));
}

const verified = spawnSync(bun, ['run', 'verify'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const log = `${verified.stdout}${verified.stderr}`;
process.stderr.write(log);
const verify = { ok: verified.status === 0, exitCode: verified.status ?? -1, tail: tail(log) };

const ok = uncommitted.length === 0 && violations.length === 0 && verify.ok;
console.log(JSON.stringify({ ok, uncommitted, violations, amendments, verify }));
process.exit(ok ? 0 : 1);
