// The git-worktree Workspace adapter's `create`, and what it reports: a real origin and a clone of it, in temporary
// directories, so no test needs the network (ADR-0018). Each case says what the clone and origin hold before it runs.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitWorktreeWorkspace } from '../../../src/adapters/git-worktree/index';
import type { RunRef } from '../../../src/ports/workspace';
import { captureEvents, eventIssues, messageOf, portFailure, rejection, timed } from '../../helpers/ports';

/** A clone of a local origin, and the environment its git runs in. */
interface Pair {
  root: string;
  origin: string;
  clone: string;
  env: Record<string, string>;
  /** Runs git in `cwd`: its trimmed stdout. A non-zero exit throws with git's stderr. */
  git(cwd: string, ...args: string[]): string;
  /** Runs git in `cwd` and gives its exit code, which is not an error. */
  exitCode(cwd: string, ...args: string[]): number;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An origin with one commit on `main`, and a clone of it made before anything else happens to the origin. */
function pair(): Pair {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sail-gw-create-')));
  dirs.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  const spawn = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], { cwd, env });
  const git = (cwd: string, ...args: string[]): string => {
    const result = spawn(cwd, args);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr}`);
    return result.stdout.toString().trim();
  };
  const origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-b', 'main');
  writeFileSync(join(origin, 'README.md'), '# origin\n');
  git(origin, 'add', 'README.md');
  git(origin, 'commit', '-m', 'initial');
  const clone = join(root, 'clone');
  git(root, 'clone', origin, clone);
  return { root, origin, clone, env, git, exitCode: (cwd, ...args) => spawn(cwd, args).exitCode };
}

/** A run directory under the clone's `.sail-runs/`, made before the test reads the clone's state. */
function runIn(p: Pair, runId: string): RunRef {
  const runDir = join(p.clone, '.sail-runs', runId);
  mkdirSync(runDir, { recursive: true });
  return { runId, runDir };
}

/** A commit on the origin after the clone was made, so only a fetch brings it to the clone. Returns its sha. */
function advance(p: Pair): string {
  writeFileSync(join(p.origin, 'CHANGELOG.md'), 'a later commit\n');
  p.git(p.origin, 'add', 'CHANGELOG.md');
  p.git(p.origin, 'commit', '-m', 'later');
  return p.git(p.origin, 'rev-parse', 'HEAD');
}

const CREATE = { base: 'origin/HEAD', branch: 'sail/FAKE-1' };

// STICKER: every case below is git-worktree's `create`, which lands in TASK-002. Each sticker names that task.

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ("create fetches origin, then detaches a worktree at origin's default branch, at the commit origin has now", async () => {
    const p = pair();
    const ahead = advance(p);
    const run = runIn(p, 'r1');
    const made = await createGitWorktreeWorkspace({ repo: p.clone, env: p.env }).create(run, CREATE);
    expect([made.path, made.baseSha]).toEqual([join(run.runDir, 'workspace'), ahead]);
    expect([p.git(made.path, 'rev-parse', 'HEAD'), p.exitCode(made.path, 'symbolic-ref', '-q', 'HEAD')]).toEqual([
      ahead,
      1,
    ]);
  });

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('workspace:created names the branch, the base commit and the path relative to the clone, and validates', async () => {
    const p = pair();
    const ahead = advance(p);
    const capture = captureEvents();
    await createGitWorktreeWorkspace({ repo: p.clone, env: p.env, emit: capture.emit }).create(runIn(p, 'r1'), CREATE);
    expect(timed(capture.events)).toEqual([
      {
        type: 'workspace:created',
        path: '.sail-runs/r1/workspace',
        branch: 'sail/FAKE-1',
        baseSha: ahead,
        durationMs: 'ms',
      },
    ]);
    expect(eventIssues(capture.stamped())).toEqual([]);
  });

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('create refuses a clone whose origin/HEAD is unset as invalid, and the message names git remote set-head origin --auto', async () => {
    const p = pair();
    p.git(p.clone, 'remote', 'set-head', 'origin', '-d');
    const run = runIn(p, 'r1');
    const error = await rejection(createGitWorktreeWorkspace({ repo: p.clone, env: p.env }).create(run, CREATE));
    expect([portFailure(error), messageOf(error).includes('git remote set-head origin --auto')]).toEqual([
      { port: 'workspace', op: 'create', code: 'invalid' },
      true,
    ]);
    expect(existsSync(join(run.runDir, 'workspace'))).toBe(false);
  });

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ("a fetch that fails is unavailable with git's message, and leaves no worktree behind", async () => {
    const p = pair();
    p.git(p.clone, 'remote', 'set-url', 'origin', join(p.root, 'gone'));
    const run = runIn(p, 'r1');
    const error = await rejection(createGitWorktreeWorkspace({ repo: p.clone, env: p.env }).create(run, CREATE));
    expect([portFailure(error), existsSync(join(run.runDir, 'workspace'))]).toEqual([
      { port: 'workspace', op: 'create', code: 'unavailable' },
      false,
    ]);
    expect(messageOf(error)).toContain('gone');
  });

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ("create leaves the clone's HEAD and working tree as they were, with an edit and another branch checked out there", async () => {
    const p = pair();
    const ahead = advance(p);
    p.git(p.clone, 'checkout', '-b', 'other');
    writeFileSync(join(p.clone, 'README.md'), 'an edit in the clone\n');
    const run = runIn(p, 'r1');
    const clone = () => [p.git(p.clone, 'rev-parse', 'HEAD'), p.git(p.clone, 'status', '--porcelain')];
    const before = clone();
    const made = await createGitWorktreeWorkspace({ repo: p.clone, env: p.env }).create(run, CREATE);
    expect([clone(), made.baseSha]).toEqual([before, ahead]);
    expect(readFileSync(join(p.clone, 'README.md'), 'utf8')).toBe('an edit in the clone\n');
  });

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('git never prompts for credentials: an origin that asks for them fails as unavailable, and promptly', async () => {
    const p = pair();
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('denied', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="sail"' } }),
    });
    try {
      p.git(p.clone, 'remote', 'set-url', 'origin', `http://127.0.0.1:${server.port}/repo.git`);
      const run = runIn(p, 'r1');
      const started = performance.now();
      const error = await rejection(createGitWorktreeWorkspace({ repo: p.clone, env: p.env }).create(run, CREATE));
      const elapsed = performance.now() - started;
      expect([portFailure(error), elapsed < 10_000]).toEqual([
        { port: 'workspace', op: 'create', code: 'unavailable' },
        true,
      ]);
    } finally {
      server.stop(true);
    }
  }, 30_000);

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('the git-worktree workspace declares keep and sweep, as the fake does', () => {
    const p = pair();
    expect(createGitWorktreeWorkspace({ repo: p.clone, env: p.env }).capabilities()).toEqual({
      keep: true,
      sweep: true,
    });
  });
