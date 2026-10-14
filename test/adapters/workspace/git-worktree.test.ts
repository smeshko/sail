// The git-worktree Workspace adapter: the port suite over a clone of a local bare origin, then what only it does (D6,
// D7): it fetches before it makes a workspace, leaves the clone's checkout alone, never lets git prompt, keys leases by
// the remote's URL without credentials, and removes a workspace git no longer knows. Every git call gets the temp
// repository's env, whose HOME is empty, so no credential helper of the machine's can answer for git.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTINS } from '../../../src/adapters/index';
import { createGitWorktreeWorkspace, gitWorktreeDefinition } from '../../../src/adapters/workspace/git-worktree';
import { resolveAdapters } from '../../../src/engine/adapters';
import { readConfig } from '../../../src/engine/config';
import { writeStatus } from '../../../src/engine/run-dir';
import { copyFixture, edit } from '../../helpers/fixture';
import { holdTempRepo } from '../../helpers/held-repo';
import { withOrigin } from '../../helpers/origin';
import { captureEvents, messageOf, portFailure, settle } from '../../helpers/ports';
import { type TempRepo, withTempRepo } from '../../helpers/temp-repo';
import { type WorkspaceWorld, workspaceSuite } from '../../ports/workspace.suite';

const BRANCH = 'sail/FAKE-1-add-a-shout-flag';
const held = holdTempRepo();
let origined = false;
/** The held repository, given its origin the first time a test asks. */
const clone = (): TempRepo => {
  if (!origined) withOrigin(held());
  origined = true;
  return held();
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp directory by its real path, as git reports worktree paths. */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-git-worktree-')));
  dirs.push(dir);
  return dir;
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true']);
  await child.exited;
  return child.pid;
}

/** Runs git in `cwd` with `repo`'s env, giving its exit code and trimmed stdout, and never throwing. */
function gitIn(repo: TempRepo, cwd: string, ...args: string[]): { code: number; stdout: string } {
  try {
    const result = Bun.spawnSync(['git', ...args], { cwd, env: repo.env, stdin: 'ignore' });
    return { code: result.exitCode, stdout: result.stdout.toString().trim() };
  } catch {
    return { code: -1, stdout: '' };
  }
}

/** A world over `repo`, a clone whose origin is set, with runs and leases of its own. */
function world(repo: TempRepo): WorkspaceWorld & { leasesDir: string } {
  const runsDir = tempDir();
  return {
    remote: repo.git('remote', 'get-url', 'origin'),
    base: 'origin/main',
    defaultBranch: 'main',
    baseSha: repo.git('rev-parse', 'origin/main'),
    tracked: 'README.md',
    runsDir,
    leasesDir: tempDir(),
    run: async (runId, status = 'running', alive = true) => {
      const runDir = join(runsDir, runId);
      mkdirSync(runDir);
      if (status === 'failed') writeStatus(runDir, status, 'workflow_failed');
      else if (status === 'suspended') writeStatus(runDir, status, 'interrupted');
      else if (status !== 'none') writeStatus(runDir, status);
      return { runId, runDir, pid: alive ? process.pid : await deadPid() };
    },
    git: (cwd, ...args) => gitIn(repo, cwd, ...args),
  };
}

/** The adapter over `repo`, with `world`'s leases. */
function adapterOf(
  repo: TempRepo,
  w: { leasesDir: string },
  extra: Partial<Parameters<typeof createGitWorktreeWorkspace>[0]> = {},
) {
  return createGitWorktreeWorkspace({ repo: repo.dir, leasesDir: w.leasesDir, env: repo.env, ...extra });
}

/** A run directory under a fresh temp directory. */
function runIn(dir: string, runId = 'r1'): { runId: string; runDir: string } {
  const runDir = join(dir, runId);
  mkdirSync(runDir, { recursive: true });
  return { runId, runDir };
}

/** A local server for `origin` to point at, stopped afterwards: it answers every request with `respond`. */
async function withServer<T>(
  respond: (request: Request) => Response | Promise<Response>,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: respond });
  try {
    return await fn(`http://127.0.0.1:${server.port}/r.git`);
  } finally {
    server.stop(true);
  }
}

describe('the port suite', () => {
  workspaceSuite('git-worktree', async (emit) => {
    const repo = clone();
    const w = world(repo);
    return { adapter: adapterOf(repo, w, { emit }), world: w };
  });
});

test('create fetches first: a commit pushed to the origin after the clone fetched is the new base, and origin/main moves to it', async () => {
  await withTempRepo(async (repo) => {
    const origin = withOrigin(repo);
    const pushed = origin.push('later.txt');
    const w = world(repo);
    const created = await settle(adapterOf(repo, w).create(runIn(w.runsDir), { branch: BRANCH }));
    expect({
      baseSha: 'rejected' in created ? created : created.baseSha,
      originMain: repo.git('rev-parse', 'origin/main'),
    }).toEqual({ baseSha: pushed, originMain: pushed });
  });
});

test("the clone is left as it was: its HEAD, its checked-out branch and its status, with an uncommitted edit and the run's branch checked out", async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    repo.git('checkout', '-q', '-b', BRANCH);
    writeFileSync(join(repo.dir, 'README.md'), 'an uncommitted edit\n', { flag: 'a' });
    writeFileSync(join(repo.dir, 'scratch.txt'), 'untracked\n');
    const look = () => ({
      head: repo.git('rev-parse', 'HEAD'),
      branch: repo.git('symbolic-ref', '--short', 'HEAD'),
      status: repo.git('status', '--porcelain'),
      readme: readFileSync(join(repo.dir, 'README.md'), 'utf8'),
    });
    const before = look();
    const w = world(repo);
    const created = await settle(adapterOf(repo, w).create(runIn(w.runsDir), { branch: BRANCH }));
    const listed = repo.git('worktree', 'list', '--porcelain').split('\n');
    expect({ ...look(), made: 'rejected' in created ? created : listed.includes(`worktree ${created.path}`) }).toEqual({
      ...before,
      made: true,
    });
  });
});

test('no git call can prompt: an origin that asks for credentials fails create as unavailable, with terminal prompts disabled', async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const w = world(repo);
    const unauthorised = () =>
      new Response('credentials, please', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="sail"' } });
    const failure = await withServer(unauthorised, async (url) => {
      repo.git('remote', 'set-url', 'origin', url);
      const started = performance.now();
      try {
        await adapterOf(repo, w, { fetchTimeoutMs: 10_000 }).create(runIn(w.runsDir), { branch: BRANCH });
        return 'created';
      } catch (error) {
        return {
          failure: portFailure(error),
          prompts: messageOf(error).includes('terminal prompts disabled'),
          quick: performance.now() - started < 10_000,
        };
      }
    });
    expect(failure).toEqual({
      failure: { port: 'workspace', op: 'create', code: 'unavailable' },
      prompts: true,
      quick: true,
    });
  });
}, 15_000);

test('a fetch that hangs is killed at fetchTimeoutMs, and one whose signal aborts is stopped', async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const w = world(repo);
    const never = () => new Promise<Response>(() => undefined);
    const ends = await withServer(never, async (url) => {
      repo.git('remote', 'set-url', 'origin', url);
      const adapter = adapterOf(repo, w, { fetchTimeoutMs: 300 });
      const timedOut = await settle(adapter.create(runIn(w.runsDir, 'r1'), { branch: BRANCH }));
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const slow = adapterOf(repo, w, { fetchTimeoutMs: 60_000 });
      const aborted = await settle(slow.create(runIn(w.runsDir, 'r2'), { branch: BRANCH, signal: controller.signal }));
      return { timedOut, aborted };
    });
    const unavailable = { rejected: { port: 'workspace', op: 'create', code: 'unavailable' } };
    expect(ends).toEqual({ timedOut: unavailable, aborted: unavailable });
    expect([existsSync(join(w.runsDir, 'r1', 'workspace')), existsSync(join(w.runsDir, 'r2', 'workspace'))]).toEqual([
      false,
      false,
    ]);
  });
}, 5_000);

test('credentials are stripped from the remote: neither repository() nor workspace:leased holds them', async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    repo.git('remote', 'set-url', 'origin', 'https://user:secret@127.0.0.1:9/o/r.git');
    const w = world(repo);
    const capture = captureEvents();
    const adapter = adapterOf(repo, w, { emit: capture.emit });
    const repository = await settle(adapter.repository());
    const url = 'rejected' in repository ? 'rejected' : repository.url;
    await adapter.lease(url, BRANCH, { ...runIn(w.runsDir), pid: process.pid });
    expect({ url, said: JSON.stringify(capture.events).includes('secret') }).toEqual({
      url: 'https://127.0.0.1:9/o/r.git',
      said: false,
    });
  });
});

test("a missing default branch is refused as invalid, naming git remote set-head and the option, and the option wins over origin's HEAD", async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const w = world(repo);
    repo.git('branch', '-f', 'trunk', 'main');
    repo.git('push', '--quiet', 'origin', 'trunk');
    const told = await settle(adapterOf(repo, w, { defaultBranch: 'trunk' }).repository());
    repo.git('remote', 'set-head', 'origin', '--delete');
    let refusal: unknown = 'resolved';
    try {
      await adapterOf(repo, w).repository();
    } catch (error) {
      refusal = {
        failure: portFailure(error),
        setHead: messageOf(error).includes('git remote set-head origin --auto'),
        option: messageOf(error).includes('defaultBranch'),
      };
    }
    expect({ told: 'rejected' in told ? told : told.defaultBranch, refusal }).toEqual({
      told: 'trunk',
      refusal: { failure: { port: 'workspace', op: 'repository', code: 'invalid' }, setHead: true, option: true },
    });
  });
});

test('release removes a workspace git no longer knows, and never a path beside it', async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const w = world(repo);
    const adapter = adapterOf(repo, w);
    const run = runIn(w.runsDir);
    const { path } = await adapter.create(run, { branch: BRANCH });
    // Its admin entry pruned: `git worktree remove` no longer takes it for a worktree.
    const dotGit = join(path, '.git');
    const gitdir = existsSync(dotGit)
      ? readFileSync(dotGit, 'utf8')
          .replace(/^gitdir: /, '')
          .trim()
      : '';
    if (gitdir !== '') rmSync(gitdir, { recursive: true, force: true });
    mkdirSync(join(run.runDir, 'workspace-notes'));
    writeFileSync(join(run.runDir, 'workspace-notes', 'keep.txt'), 'keep\n');
    writeFileSync(join(run.runDir, 'keep.txt'), 'keep\n');
    const released = await settle(adapter.release(run, false));
    expect({
      released: 'rejected' in released ? released : released.kept,
      workspace: existsSync(path),
      beside: [existsSync(join(run.runDir, 'workspace-notes', 'keep.txt')), existsSync(join(run.runDir, 'keep.txt'))],
    }).toEqual({ released: false, workspace: false, beside: [true, true] });
  });
});

test('nothing is symlinked or copied into a workspace: the clone has an untracked .env, and the workspace has no untracked or ignored file', async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    writeFileSync(join(repo.dir, '.env'), 'TOKEN=secret\n');
    const w = world(repo);
    const created = await settle(adapterOf(repo, w).create(runIn(w.runsDir), { branch: BRANCH }));
    const path = 'rejected' in created ? w.runsDir : created.path;
    expect({
      made: gitIn(repo, path, 'rev-parse', '--show-toplevel').stdout === path,
      extra: gitIn(repo, path, 'status', '--porcelain', '--ignored').stdout,
    }).toEqual({ made: true, extra: '' });
  });
});

/** An executable script at `path` that appends its arguments to `log`, then runs `then`. */
function logging(path: string, log: string, then: string): string {
  writeFileSync(path, `#!/bin/sh\necho "$*" >>"${log}"\n${then}\n`, { mode: 0o755 });
  return path;
}

test('no askpass runs either: GIT_ASKPASS, SSH_ASKPASS and core.askPass are never asked, by an origin that wants credentials (review #1.2)', async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const w = world(repo);
    const dir = tempDir();
    const log = join(dir, 'asked.log');
    const askpass = logging(join(dir, 'askpass'), log, 'echo guess');
    repo.git('config', 'core.askPass', askpass);
    const env = { ...repo.env, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force' };
    const unauthorised = () =>
      new Response('credentials, please', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="sail"' } });
    const created = await withServer(unauthorised, async (url) => {
      repo.git('remote', 'set-url', 'origin', url);
      return settle(adapterOf(repo, w, { env, fetchTimeoutMs: 10_000 }).create(runIn(w.runsDir), { branch: BRANCH }));
    });
    expect({ created, asked: existsSync(log) ? readFileSync(log, 'utf8') : '' }).toEqual({
      created: { rejected: { port: 'workspace', op: 'create', code: 'unavailable' } },
      asked: '',
    });
  });
}, 15_000);

test("the user's own ssh stays theirs: a fetch over ssh runs core.sshCommand, or GIT_SSH, as a plain git fetch would (review #1.3)", async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const w = world(repo);
    const dir = tempDir();
    /** Whether the script that logs to `log` was run for the origin's host. */
    const ranFor = (log: string) => existsSync(log) && readFileSync(log, 'utf8').includes('sail.invalid');
    const configuredLog = join(dir, 'configured.log');
    const wrapperLog = join(dir, 'wrapper.log');
    repo.git('remote', 'set-url', 'origin', 'ssh://git@sail.invalid/o/r.git');
    repo.git('config', 'core.sshCommand', logging(join(dir, 'configured'), configuredLog, 'exit 1'));
    const configured = await settle(adapterOf(repo, w).create(runIn(w.runsDir, 'r1'), { branch: BRANCH }));
    repo.git('config', '--unset', 'core.sshCommand');
    const env = { ...repo.env, GIT_SSH: logging(join(dir, 'wrapper'), wrapperLog, 'exit 1') };
    const wrapped = await settle(adapterOf(repo, w, { env }).create(runIn(w.runsDir, 'r2'), { branch: BRANCH }));
    const unavailable = { rejected: { port: 'workspace', op: 'create', code: 'unavailable' } };
    expect({ configured, wrapped, ran: [ranFor(configuredLog), ranFor(wrapperLog)] }).toEqual({
      configured: unavailable,
      wrapped: unavailable,
      ran: [true, true],
    });
  });
});

test("git variables a hook hands down never point git at the clone: GIT_INDEX_FILE set to the clone's index leaves what it stages alone (review #1.6)", async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const w = world(repo);
    writeFileSync(join(repo.dir, 'staged.txt'), 'staged\n');
    repo.git('add', 'staged.txt');
    const env = {
      ...repo.env,
      GIT_INDEX_FILE: join(repo.dir, '.git', 'index'),
      GIT_DIR: join(repo.dir, '.git'),
      GIT_WORK_TREE: repo.dir,
    };
    const adapter = adapterOf(repo, w, { env });
    const created = await settle(adapter.create(runIn(w.runsDir), { branch: BRANCH }));
    const path = 'rejected' in created ? w.runsDir : created.path;
    writeFileSync(join(path, 'made.txt'), 'made\n');
    const diff = await settle(adapter.diff(path, 'HEAD'));
    expect({
      staged: repo.git('diff', '--cached', '--name-only'),
      made: 'rejected' in created ? created : gitIn(repo, path, 'rev-parse', 'HEAD').stdout === created.baseSha,
      diffed: 'rejected' in diff ? diff : [...diff.patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]),
    }).toEqual({ staged: 'staged.txt', made: true, diffed: ['made.txt'] });
  });
});

test("a workspace is made with no hook of the clone's: neither its post-checkout hook nor one under core.hooksPath runs (review #1.4)", async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const w = world(repo);
    const dir = tempDir();
    const log = join(dir, 'hooks.log');
    const hook = (hooks: string) => {
      mkdirSync(hooks, { recursive: true });
      logging(join(hooks, 'post-checkout'), log, 'exit 0');
    };
    hook(join(repo.dir, '.git', 'hooks'));
    const created = await settle(adapterOf(repo, w).create(runIn(w.runsDir, 'r1'), { branch: BRANCH }));
    hook(join(dir, 'husky'));
    repo.git('config', 'core.hooksPath', join(dir, 'husky'));
    const configured = await settle(adapterOf(repo, w).create(runIn(w.runsDir, 'r2'), { branch: BRANCH }));
    expect({
      made: ['rejected' in created ? created : 'made', 'rejected' in configured ? configured : 'made'],
      hooks: existsSync(log) ? readFileSync(log, 'utf8') : '',
    }).toEqual({ made: ['made', 'made'], hooks: '' });
  });
});

test('git-worktree is a built-in for the workspace port alone: its options are remote and defaultBranch, and any other is refused by name', async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const sailDir = copyFixture(repo.dir);
    edit(
      sailDir,
      'project.yaml',
      'workspace: { use: fake }',
      'workspace: { use: git-worktree, remote: origin, defaultBranch: main }',
    );
    const config = readConfig(sailDir);
    if ('issues' in config) throw new Error(JSON.stringify(config.issues));
    const resolved = await resolveAdapters({ sailDir, config, builtins: BUILTINS, env: repo.env });
    const context = { root: repo.dir, sailDir, runsDir: join(repo.dir, '.sail-runs'), env: repo.env };
    let refused = 'created';
    try {
      await gitWorktreeDefinition.create({ remotes: 'origin' }, context);
    } catch (error) {
      refused = messageOf(error);
    }
    expect({
      builtins: Object.fromEntries(Object.entries(BUILTINS).map(([name, ports]) => [name, Object.keys(ports)])),
      resolved: 'issues' in resolved ? resolved.issues : resolved.ports.workspace.name,
      refused: refused.includes('remotes') ? 'names remotes' : refused,
    }).toEqual({
      builtins: {
        fake: ['ticketSource', 'codeHost', 'harness', 'workspace'],
        'git-worktree': ['workspace'],
      },
      resolved: 'git-worktree',
      refused: 'names remotes',
    });
  });
});

/** The worktrees `repo` registers, by path. */
const registered = (repo: TempRepo): string[] =>
  repo
    .git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));

test('a symlink where a workspace should be is unlinked, never followed: release and sweep leave the worktree it names alone (review #1.7)', async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const w = world(repo);
    const adapter = adapterOf(repo, w);
    const other = await w.run('other');
    const { path: target } = await adapter.create(other, { branch: BRANCH });
    // A run whose workspace is a link to another run's, and an ended run whose directory is a link to that run's.
    const linked = await w.run('linked', 'completed');
    symlinkSync(target, join(linked.runDir, 'workspace'));
    const released = await settle(adapter.release(linked, false));
    const afterRelease = [existsSync(join(target, 'README.md')), registered(repo).includes(target)];
    symlinkSync(other.runDir, join(w.runsDir, 'aliased'));
    writeStatus(other.runDir, 'completed');
    const swept = await settle(adapter.sweep(w.runsDir));
    expect({
      released: 'rejected' in released ? released : released.kept,
      link: existsSync(join(linked.runDir, 'workspace')),
      afterRelease,
      // Swept once, as the ended run's own, and never through the link to it.
      swept: 'rejected' in swept ? swept : swept.paths,
      afterSweep: [existsSync(join(target, 'README.md')), registered(repo).includes(target)],
    }).toEqual({
      released: false,
      link: false,
      afterRelease: [true, true],
      swept: [target],
      afterSweep: [false, false],
    });
  });
});

test("a release prunes only what it removed by hand: a worktree of the user's whose directory is away stays registered (review #1.8)", async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const w = world(repo);
    const adapter = adapterOf(repo, w);
    const dir = tempDir();
    const mine = join(dir, 'mine');
    repo.git('worktree', 'add', '--quiet', '--detach', mine, 'HEAD');
    // As on a volume that isn't mounted right now.
    renameSync(mine, join(dir, 'away'));
    const run = runIn(w.runsDir);
    await adapter.create(run, { branch: BRANCH });
    const released = await settle(adapter.release(run, false));
    expect({
      released: 'rejected' in released ? released : released.kept,
      mine: registered(repo).includes(mine),
    }).toEqual({ released: false, mine: true });
  });
});

test('a run directory that is a link is refused by release, and the worktree it leads to stays (review #2.5)', async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const w = world(repo);
    const adapter = adapterOf(repo, w);
    const other = await w.run('other');
    const { path: target } = await adapter.create(other, { branch: BRANCH });
    const linked = { runId: 'linked', runDir: join(w.runsDir, 'linked') };
    symlinkSync(other.runDir, linked.runDir);
    const released = await settle(adapter.release(linked, false));
    expect({
      released,
      target: [existsSync(join(target, 'README.md')), registered(repo).includes(target)],
    }).toEqual({
      released: { rejected: { port: 'workspace', op: 'release', code: 'unavailable' } },
      target: [true, true],
    });
  });
});

test('a locked workspace is still removed on release, and git no longer lists it (review #2.6)', async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const w = world(repo);
    const adapter = adapterOf(repo, w);
    const run = runIn(w.runsDir);
    const { path } = await adapter.create(run, { branch: BRANCH });
    repo.git('worktree', 'lock', path);
    const released = await settle(adapter.release(run, false));
    expect({
      released: 'rejected' in released ? released : released.kept,
      workspace: existsSync(path),
      listed: registered(repo).includes(path),
    }).toEqual({ released: false, workspace: false, listed: false });
  });
});
