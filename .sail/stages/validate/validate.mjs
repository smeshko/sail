// Validates the branch in the workspace and prints the Validation: what is uncommitted, and how `bun run gate` ended:
// typecheck, lint and the affected tests. The full suite with its coverage gate is CI's `verify` check on the pull
// request, which the run doesn't wait for. The gate's output goes to stderr as it comes, so the call's log fills while the
// gate runs. A validation tests what changed since the branch's last validated commit, when it has one, so the
// validation after a fix tests only what the fix changed: typecheck and lint still check everything.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const bun = process.env.SAIL_BUN ?? 'bun';
const tail = (text, lines = 80) => text.split('\n').slice(-lines).join('\n').slice(-8000);

const status = spawnSync('git', ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '--untracked-files=all'], {
  cwd: root,
  encoding: 'utf8',
});
if (status.status !== 0) throw new Error(`git status: ${status.stderr.trim()}`);
const uncommitted = status.stdout
  .split('\n')
  .filter(Boolean)
  .map((line) => line.slice(3));

/** Runs git in the workspace: its trimmed stdout, or undefined when it fails. */
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const isAncestor = (commit, of) =>
  spawnSync('git', ['merge-base', '--is-ancestor', commit, of], { cwd: root }).status === 0;

// The commits that passed validation, oldest first, in the repository's common git directory: every run's workspace
// is a worktree of the same repository, so review sees the commits the factory validated.
const BASE = 'origin/staging';
const validated = join(resolve(root, git('rev-parse', '--git-common-dir') ?? '.git'), 'sail-validated');
const head = git('rev-parse', 'HEAD');

/** The branch's last validated commit. One already on the base doesn't count: its diff would hold the base's changes. */
function lastValidated() {
  let commits;
  try {
    commits = readFileSync(validated, 'utf8').split('\n').filter(Boolean);
  } catch {
    return undefined;
  }
  if (commits.length > 1000) writeFileSync(validated, `${commits.slice(-500).join('\n')}\n`);
  return commits.reverse().find((commit) => isAncestor(commit, 'HEAD') && !isAncestor(commit, BASE));
}

const since = lastValidated();
if (since) process.stderr.write(`validate: testing what changed since ${since.slice(0, 12)}, validated last\n`);

/** Runs the gate, passing its stdout and stderr through to stderr as they come, and collecting both in order. */
function gate() {
  return new Promise((resolve) => {
    const child = spawn(bun, ['run', 'gate', ...(since ? ['--base', since] : [])], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    const pass = (chunk) => {
      chunks.push(chunk);
      process.stderr.write(chunk);
    };
    child.stdout.on('data', pass);
    child.stderr.on('data', pass);
    child.on('error', (error) => resolve({ code: null, log: `${error.message}\n` }));
    child.on('close', (code) => resolve({ code, log: Buffer.concat(chunks).toString('utf8') }));
  });
}

const { code, log } = await gate();
const verify = { ok: code === 0, exitCode: code ?? -1, tail: failures(log) ?? tail(log) };

/**
 * Each failing test with the error lines Bun printed above it, then the counts: what the implementer needs, which the
 * plain tail leaves out. Undefined when no test failed, as when typecheck or lint stopped the gate.
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

const ok = uncommitted.length === 0 && verify.ok;
if (ok && head) appendFileSync(validated, `${head}\n`);
console.log(JSON.stringify({ ok, uncommitted, verify }));
process.exit(ok ? 0 : 1);
