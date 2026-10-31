// Validates the branch in the workspace and prints the Validation: what is uncommitted, and how `bun run gate` ended:
// typecheck, lint and the affected tests. The full suite with its coverage gate is CI's `verify` check on the pull
// request, which the run doesn't wait for. The gate's output goes to stderr as it comes, so the call's log fills while the
// gate runs. A validation tests what changed since the branch's last validated commit, when it has one, so the
// validation after a fix tests only what the fix changed: typecheck and lint still check everything. One gate runs at a
// time on the machine: its test files already take a worker per core, and two runs' gates side by side slow each other.
// The lock is lib/gate-lock.mjs's, and the gate and the reruns carry validate's pid in SAIL_GATE_LOCK_HOLDER, so the
// test launcher knows the lock it finds is validate's own.
// A gate that outlasts GATE_SECONDS is stopped and fails the validation, so a hung gate never holds the lock for good.
// A failing test is judged before it goes back to the implementer: one that passes when its file runs again is flaky,
// and one that also fails on the branch's merge-base is the base's. Failures that are all flaky pass; failures that are
// all the base's, or flaky, set baseRed, which ends the run instead of another pass: no change of the branch fixes it.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = process.cwd();
const bun = process.env.SAIL_BUN ?? 'bun';
const tail = (text, lines = 80) => text.split('\n').slice(-lines).join('\n').slice(-8000);
const GATE_SECONDS = Number(process.env.SAIL_GATE_SECONDS ?? 1500);
const RERUN_SECONDS = Number(process.env.SAIL_RERUN_SECONDS ?? 600);

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

/**
 * Runs the gate, passing its stdout and stderr through to stderr as they come, and collecting both in order. The gate
 * leads a process group of its own, so one past GATE_SECONDS is stopped with its test workers.
 */
function gate() {
  return new Promise((resolve) => {
    const child = spawn(bun, ['run', 'gate', ...(since ? ['--base', since] : [])], {
      cwd: root,
      env: holderEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const chunks = [];
    const pass = (chunk) => {
      chunks.push(chunk);
      process.stderr.write(chunk);
    };
    const stop = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    // Its own group is out of reach of the stage's: a stopped validation stops the gate itself.
    for (const [signal, code] of [
      ['SIGTERM', 143],
      ['SIGINT', 130],
      ['SIGHUP', 129],
    ]) {
      process.once(signal, () => {
        stop();
        process.exit(code);
      });
    }
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      stop();
    }, GATE_SECONDS * 1000);
    child.stdout.on('data', pass);
    child.stderr.on('data', pass);
    child.on('error', (error) => resolve({ code: null, log: `${error.message}\n` }));
    child.on('close', (code) => {
      clearTimeout(timer);
      const log = Buffer.concat(chunks).toString('utf8');
      resolve(
        late
          ? { code: null, log: `${log}\nvalidate: the gate outlasted ${GATE_SECONDS} s and was stopped\n` }
          : { code, log },
      );
    });
  });
}

const { HOLDER_ENV, lock } = await import(join(dirname(process.env.SAIL_CONFIG), 'lib/gate-lock.mjs'));
const holderEnv = { ...process.env, [HOLDER_ENV]: String(process.pid) };
await lock({ label: 'validate', waiting: (dir) => `waiting for the validation in ${dir}` });
const { code, log } = await gate();
const failing = code === 1 ? failingTests(log) : [];
const judged = failing.length > 0 ? await classify(failing) : [];
const flaky = judged.filter((each) => each.verdict === 'flaky');
const red = judged.filter((each) => each.verdict === 'base');
const verdicts = [
  flaky.length > 0
    ? `validate: ${flaky.length} flaky, passing on a rerun: ${flaky.map((each) => each.test).join('; ')}`
    : '',
  red.length > 0 ? `validate: ${red.length} failing on the base too: ${red.map((each) => each.test).join('; ')}` : '',
]
  .filter(Boolean)
  .join('\n');
const verify = {
  ok: code === 0,
  exitCode: code ?? -1,
  tail: [verdicts, failures(log) ?? tail(log)].filter(Boolean).join('\n\n'),
  failures: judged,
};
// Failures that are all flaky pass the validation; failures that are all the base's, or flaky, are staging's to fix.
const onlyFlaky = judged.length > 0 && flaky.length === judged.length;
const baseRed = red.length > 0 && red.length + flaky.length === judged.length;

/**
 * Each test that failed in the gate's log, once, with the file whose header Bun printed last above it: Bun prints a
 * file's name before each run of its results, and every failure again, without it, in its closing summary.
 */
function failingTests(text) {
  const found = new Map();
  let file;
  for (const line of text.split('\n')) {
    const header = /^(test\/\S+\.test\.ts):$/.exec(line);
    if (header) file = header[1];
    if (!line.startsWith('(fail) ') || file === undefined) continue;
    const test = line.slice('(fail) '.length).replace(/ \[[\d.]+m?s\]$/, '');
    if (!found.has(test)) found.set(test, { test, file });
  }
  return [...found.values()];
}

/**
 * The tests that failed in a run of `files` in `cwd`, by name, or undefined when it didn't end, or failed naming no
 * test: Bun prints a failing test's name, but not always a passing one's.
 */
function rerun(files, cwd) {
  const result = spawnSync(bun, ['run', 'test', ...files], {
    cwd,
    env: holderEnv,
    encoding: 'utf8',
    timeout: RERUN_SECONDS * 1000,
    killSignal: 'SIGKILL',
  });
  if (result.signal !== null || result.status === null) return undefined;
  const failed = new Set(
    `${result.stdout}\n${result.stderr}`
      .split('\n')
      .filter((line) => line.startsWith('(fail) '))
      .map((line) => line.slice('(fail) '.length).replace(/ \[[\d.]+m?s\]$/, '')),
  );
  return result.status !== 0 && failed.size === 0 ? undefined : failed;
}

/**
 * Each failing test's verdict: `flaky` when a rerun of its file in the workspace doesn't fail it, `base` when it fails
 * on the branch's merge-base with the base too, and `change` otherwise. The base is checked out in a scratch worktree
 * with its own dependencies, and removed after.
 */
async function classify(failing) {
  const files = [...new Set(failing.map((each) => each.file))];
  process.stderr.write(`validate: running ${files.length} failing test file(s) again\n`);
  const again = rerun(files, root);
  const still = failing.filter((each) => again === undefined || again.has(each.test));
  const verdict = (each, base) => ({
    ...each,
    verdict: !still.includes(each) ? 'flaky' : base?.has(each.test) ? 'base' : 'change',
  });
  const mergeBase = git('merge-base', 'HEAD', BASE);
  const onBase = [...new Set(still.map((each) => each.file))].filter(
    (file) =>
      mergeBase !== undefined &&
      spawnSync('git', ['cat-file', '-e', `${mergeBase}:${file}`], { cwd: root }).status === 0,
  );
  if (onBase.length === 0) return failing.map((each) => verdict(each, undefined));
  const dir = mkdtempSync(join(tmpdir(), 'sail-validate-base-'));
  try {
    process.stderr.write(`validate: running ${onBase.length} test file(s) on the base, ${mergeBase.slice(0, 12)}\n`);
    if (spawnSync('git', ['worktree', 'add', '--detach', dir, mergeBase], { cwd: root }).status !== 0) {
      return failing.map((each) => verdict(each, undefined));
    }
    const installed = spawnSync(bun, ['install', '--frozen-lockfile'], { cwd: dir, encoding: 'utf8' });
    const base = installed.status === 0 ? rerun(onBase, dir) : undefined;
    return failing.map((each) => verdict(each, base));
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root });
    rmSync(dir, { recursive: true, force: true });
  }
}

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

const ok = uncommitted.length === 0 && (verify.ok || onlyFlaky);
if (ok && head) appendFileSync(validated, `${head}\n`);
console.log(JSON.stringify({ ok, uncommitted, verify, baseRed }));
process.exit(ok ? 0 : 1);
