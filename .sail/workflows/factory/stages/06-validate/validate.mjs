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
const verify = { ok: verified.status === 0, exitCode: verified.status ?? -1, tail: failures(log) ?? tail(log) };

/**
 * Each failing test with the error lines Bun printed above it, then the counts: what the implementer needs, which the
 * plain tail, all coverage table, leaves out. Undefined when no test failed, as when typecheck or lint stopped verify.
 */
function failures(text) {
  const lines = text.split('\n');
  const blocks = new Map();
  let from = 0;
  lines.forEach((line, at) => {
    if (/^\((pass|skip)\)/.test(line)) from = at + 1;
    if (!line.startsWith('(fail)')) return;
    // Bun prints each failure again in its closing summary, without the error above it.
    const name = line.replace(/ \[[\d.]+m?s\]$/, '');
    if (!blocks.has(name)) blocks.set(name, lines.slice(Math.max(from, at - 20), at).join('\n'));
    from = at + 1;
  });
  if (blocks.size === 0) return undefined;
  let errors = '';
  for (const [name, block] of blocks) {
    if (errors.length + block.length > 5000) break;
    errors += `${block}\n${name}\n\n`;
  }
  const counts = lines.filter((line) => /^ \d+ (pass|skip|fail)$|^Ran \d+ tests/.test(line)).join('\n');
  return [
    `${blocks.size} failing test${blocks.size === 1 ? '' : 's'}:`,
    [...blocks.keys()].join('\n'),
    'The first ones, with their errors:',
    errors.trimEnd(),
    counts,
  ].join('\n\n');
}

const ok = uncommitted.length === 0 && violations.length === 0 && verify.ok;
console.log(JSON.stringify({ ok, uncommitted, violations, amendments, verify }));
process.exit(ok ? 0 : 1);
