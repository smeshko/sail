// A run in its workspace (D1, D4, D9, D10): a fresh run leases its branch, makes its run directory and its worktree,
// claims, then writes run.json, and a refusal on the way undoes all of it. Its steps run in the worktree, on its branch,
// while `.sail/` and every recorded path stay the repository's. A run that ends for good releases its workspace and its
// lease before run:end, and a stage consuming gitDiff() finds the run's patch in $STAGE_IN. All on the fakes, whose
// leases live in the repository's `.sail-runs/fake/leases/`.
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { leaseFile, readLease, takeLease } from '../../src/adapters/leases';
import { EXIT_OK } from '../../src/cli/exit-codes';
import type { ResolvedAdapters } from '../../src/engine/adapters';
import { openRun } from '../../src/engine/open-run';
import { writeStatus } from '../../src/engine/run-dir';
import { RUN_HEADER_FILE, readRunHeader } from '../../src/engine/run-header';
import { type RunEnd, type RunWorkflowOptions, resumeWorkflow, runWorkflow } from '../../src/engine/runtime';
import { formatIssue, validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import type { Consumer, SailEvent } from '../../src/events/types';
import { PortError } from '../../src/ports/errors';
import type { HarnessRequest } from '../../src/ports/harness';
import { fakeAdapters } from '../helpers/adapters';
import { AGENT_WORKFLOW, SPEC, submits, writeAgentFixture } from '../helpers/agent-fixture';
import { edit } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { sharedSource } from '../helpers/seeded';
import { copyRun, writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

/** The stub's FAKE-1, 'Add a greeting', on the default prefix. */
const BRANCH = 'sail/FAKE-1-add-a-greeting';
const REMOTE = 'fake://origin';

/** Where the fakes keep their leases in `repoDir`. */
const leasesOf = (repoDir: string) => join(repoDir, '.sail-runs', 'fake', 'leases');

/** The runs in `repoDir`'s `.sail-runs/`: every entry but `fake/`. */
const runIds = (repoDir: string): string[] =>
  existsSync(join(repoDir, '.sail-runs'))
    ? readdirSync(join(repoDir, '.sail-runs')).filter((name) => name !== 'fake')
    : [];

/** The worktrees git lists for `repo`, other than the repository itself. */
const worktrees = (repo: TempRepo): string[] =>
  repo
    .git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((path) => path !== repo.dir);

/** Runs ticket-to-pr from `cwd` on `FAKE-1`, or as `options` say. It must not be refused. */
async function ran(cwd: string, options: Partial<RunWorkflowOptions> = {}): Promise<RunEnd> {
  const end = await runWorkflow({
    cwd,
    adapters: await fakeAdapters(cwd),
    workflow: 'ticket-to-pr',
    ticket: 'FAKE-1',
    ...options,
  });
  if ('refused' in end) throw new Error(`refused: ${end.refused}`);
  return end;
}

/** A file's text, or '' when there is none. */
const textOf = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** A call's `result.json`. */
const resultOf = (runDir: string, call: string): Record<string, unknown> =>
  JSON.parse(textOf(join(runDir, call, 'result.json')) || '{}');

/** The fake ticket as the fakes left it in `repoDir`. */
async function ticketIn(repoDir: string, ticketKey: string) {
  return (await fakeAdapters(repoDir)).ports.ticketSource.get(ticketKey);
}

/** A copy of a stub script's body, with `lines` run before it. */
const before = (sail: string, script: string, anchor: string, lines: string) =>
  edit(sail, script, anchor, `${lines}\n${anchor}`);

const SPEC_SCRIPT = 'workflows/ticket-to-pr/stages/spec/run.sh';
const SPEC_BODY = "printf '# Spec";
const IMPLEMENT_SCRIPT = 'stages/implement/run.sh';
const IMPLEMENT_BODY = "echo 'diff --git a/src/greet.ts b/src/greet.ts'";
const TESTS_SCRIPT = 'stages/tests/run.sh';
const TESTS_BODY = 'pass_at=2';

// The start: lease, run directory and workspace, run.json. The intake claims later.

test('a fresh run leases its branch before its run directory exists and opens without a claim, and run.json records the branch, the repository and the workspace', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const adapters = await fakeAdapters(repo.dir);
    const seen: string[] = [];
    const { workspace, ticketSource } = adapters.ports;
    const lease = workspace.lease.bind(workspace);
    workspace.lease = async (remote, branch, holder) => {
      seen.push(`lease: run directory ${existsSync(holder.runDir) ? 'made' : 'not made'}`);
      return lease(remote, branch, holder);
    };
    const claim = ticketSource.claim.bind(ticketSource);
    ticketSource.claim = async (ticketKey) => {
      seen.push('claim');
      return claim(ticketKey);
    };
    const opened = await openRun({ cwd: repo.dir, workflow: 'ticket-to-pr', ticket: 'FAKE-1', adapters });
    if ('refused' in opened) throw new Error(opened.refused);
    const header = readRunHeader(opened.dir);
    const baseSha = repo.git('rev-parse', 'main');
    expect({
      seen,
      header: { branch: header.branch, repository: header.repository, workspace: header.workspace },
      workspace: opened.workspace,
      started: opened.started,
    }).toEqual({
      seen: ['lease: run directory not made'],
      header: { branch: BRANCH, repository: { url: REMOTE, defaultBranch: 'main', baseSha }, workspace: 'workspace' },
      workspace: { path: join(opened.dir, 'workspace'), branch: BRANCH, baseSha, remote: REMOTE },
      started: [
        { type: 'workspace:leased', remote: REMOTE, branch: BRANCH },
        {
          type: 'workspace:created',
          path: `.sail-runs/${opened.runId}/workspace`,
          branch: BRANCH,
          baseSha,
          durationMs: expect.any(Number),
        },
      ],
    });
  });
});

test('a completed run reports its lease and workspace right after run:start, each path relative to the repository, and releases both before run:end', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const end = await ran(repo.dir);
    const list = readEvents(end.dir);
    const workspace = `.sail-runs/${end.runId}/workspace`;
    const strip = ({ seq: _seq, ts: _ts, runId: _runId, ...payload }: SailEvent) => payload;
    expect({
      opening: list.slice(1, 3).map(strip),
      closing: list.slice(-3).map(strip),
      issues: validateRunDir(end.dir).issues.map(formatIssue),
      left: { worktrees: worktrees(repo), lease: readLease(leasesOf(repo.dir), REMOTE, BRANCH) ?? null },
    }).toEqual({
      opening: [
        { type: 'workspace:leased', remote: REMOTE, branch: BRANCH },
        {
          type: 'workspace:created',
          path: workspace,
          branch: BRANCH,
          baseSha: repo.git('rev-parse', 'main'),
          durationMs: expect.any(Number),
        },
      ],
      closing: [
        { type: 'workspace:released', path: workspace, kept: false },
        { type: 'workspace:lease_released', remote: REMOTE, branch: BRANCH },
        { type: 'run:end', status: 'completed', result: end.result, replays: 6 },
      ],
      issues: [],
      left: { worktrees: [], lease: null },
    });
  });
});

/** Where a refused start of FAKE-1 left things, once `change` has set up how it is refused. */
async function refusedStart(change: (adapters: ResolvedAdapters, abort: () => void) => void) {
  return withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const adapters = await fakeAdapters(repo.dir);
    const controller = new AbortController();
    change(adapters, () => controller.abort());
    const end = await runWorkflow({
      cwd: repo.dir,
      adapters,
      workflow: 'ticket-to-pr',
      ticket: 'FAKE-1',
      signal: controller.signal,
    });
    const ticket = await ticketIn(repo.dir, 'FAKE-1');
    return {
      end,
      runs: runIds(repo.dir),
      worktrees: worktrees(repo),
      lease: readLease(leasesOf(repo.dir), REMOTE, BRANCH) ?? null,
      ticket: { state: ticket.state.name, comments: ticket.comments.length },
    };
  });
}

test('a claim lost to another start fails the run at its intake, keeping the run directory but releasing the worktree and the lease, and an abort once the workspace exists leaves no run directory, no worktree and no lease; the ticket is as it was in both', async () => {
  const lostClaim = await refusedStart((adapters) => {
    adapters.ports.ticketSource.claim = async () => ({
      claimed: false,
      state: { type: 'started', name: 'In Progress' },
      raw: null,
    });
  });
  const aborted = await refusedStart((adapters, abort) => {
    const { workspace } = adapters.ports;
    const create = workspace.create.bind(workspace);
    workspace.create = async (run, from) => {
      const made = await create(run, from);
      abort();
      return made;
    };
  });
  const left = { runs: [], worktrees: [], lease: null, ticket: { state: 'Todo', comments: 1 } };
  expect({ lostClaim, aborted }).toEqual({
    lostClaim: {
      end: expect.objectContaining({
        status: 'failed',
        stopReason: 'stage_error',
        message: expect.stringContaining(
          'ticketSource.claim: the ticket is already claimed: it became In Progress while sail was starting. --force runs it anyway (conflict)',
        ),
      }),
      ...left,
      runs: [expect.stringMatching(/^FAKE-1-/)],
    },
    aborted: { end: { refused: 'stopped before the run was opened' }, ...left },
  });
});

// The end: a suspended run keeps both, a run that ended for good releases both.

test('a run.json that cannot be written once the workspace is made throws, and leaves no run directory, no worktree and no lease (review #1.11)', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const adapters = await fakeAdapters(repo.dir);
    const { workspace } = adapters.ports;
    const create = workspace.create.bind(workspace);
    // Once the workspace is made, run.json's name is taken by a directory: writing it fails.
    workspace.create = async (run, options) => {
      const made = await create(run, options);
      mkdirSync(join(run.runDir, RUN_HEADER_FILE), { recursive: true });
      return made;
    };
    let thrown = 'opened';
    try {
      await openRun({ cwd: repo.dir, adapters, workflow: 'ticket-to-pr', ticket: 'FAKE-1' });
    } catch (error) {
      thrown = (error as Error).message.replace(/'s directory .*$/s, '');
    }
    expect({
      thrown,
      runs: runIds(repo.dir),
      worktrees: worktrees(repo),
      lease: readLease(leasesOf(repo.dir), REMOTE, BRANCH) ?? null,
    }).toEqual({ thrown: expect.stringMatching(/^run FAKE-1-\w+$/), runs: [], worktrees: [], lease: null });
  });
});

test('a suspended run marks its lease as held by no process after run:end', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    let markAtEnd: boolean | undefined;
    const suspended = await ran(repo.dir, {
      until: 'spec',
      consumers: [
        {
          name: 'ordering',
          onEvent: (event) => {
            if (event.type === 'run:end') markAtEnd = readLease(leasesOf(repo.dir), REMOTE, BRANCH)?.suspended ?? false;
          },
        },
      ],
    });
    expect(markAtEnd).toBe(false);
    expect(readLease(leasesOf(repo.dir), REMOTE, BRANCH)).toMatchObject({
      runId: suspended.runId,
      pid: process.pid,
      suspended: true,
    });
    expect(readEvents(suspended.dir).at(-1)?.type).toBe('run:end');
    const kept = {
      status: suspended.status,
      worktree: existsSync(join(suspended.dir, 'workspace', '.git')),
      lease: readLease(leasesOf(repo.dir), REMOTE, BRANCH)?.runId,
    };
    await withTempRepo(async (other) => {
      writeStub(other.dir, { testsPassAt: 99 });
      const failed = await ran(other.dir);
      expect({
        kept,
        failed: {
          status: failed.status,
          worktree: existsSync(join(failed.dir, 'workspace')),
          worktrees: worktrees(other),
          lease: readLease(leasesOf(other.dir), REMOTE, BRANCH) ?? null,
        },
      }).toEqual({
        kept: { status: 'suspended', worktree: true, lease: suspended.runId },
        failed: { status: 'failed', worktree: false, worktrees: [], lease: null },
      });
    });
  });
});

test('a failed lease mark leaves the suspended end and its last event intact', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const adapters = await fakeAdapters(repo.dir);
    const lease = adapters.ports.workspace.lease.bind(adapters.ports.workspace);
    adapters.ports.workspace.lease = async (remote, branch, holder) => {
      if (holder.suspended) throw new PortError('workspace', 'lease', 'unavailable', 'cannot mark');
      return lease(remote, branch, holder);
    };
    const end = await ran(repo.dir, { adapters, until: 'spec' });
    expect(end.status).toBe('suspended');
    expect(readEvents(end.dir).at(-1)?.type).toBe('run:end');
    expect(readLease(leasesOf(repo.dir), REMOTE, BRANCH)?.suspended).toBeUndefined();
  });
});

test('a suspended run whose marked lease names a live, unrelated pid resumes to completion', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const runId = await withTempRepo(async (from) => {
      writeStub(from.dir);
      const end = await ran(from.dir, { until: 'spec' });
      copyRun(from.dir, repo.dir);
      return end.runId;
    });
    const child = Bun.spawn(['sleep', '30'], { env: repo.env });
    try {
      const file = leaseFile(leasesOf(repo.dir), REMOTE, BRANCH);
      mkdirSync(leasesOf(repo.dir), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          remote: REMOTE,
          branch: BRANCH,
          runId,
          runDir: join(repo.dir, '.sail-runs', runId),
          takenAt: new Date().toISOString(),
          pid: child.pid,
          suspended: true,
        }),
      );
      const end = await resumeWorkflow({
        cwd: repo.dir,
        adapters: await fakeAdapters(repo.dir),
        runId,
      });
      expect('refused' in end ? end : end.status).toBe('completed');
      expect(readLease(leasesOf(repo.dir), REMOTE, BRANCH)).toBeUndefined();
    } finally {
      child.kill();
      await child.exited;
    }
  });
});

test("a failed run that committed in its workspace keeps its commits at refs/sail/runs/<runId>, which workspace:released records, and run:end's message stays the run's own", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir, { testsPassAt: 99 });
    before(sail, IMPLEMENT_SCRIPT, IMPLEMENT_BODY, 'git -C "$WORKSPACE" commit -q --allow-empty -m "implement $CALL"');
    const end = await ran(repo.dir);
    const ref = `refs/sail/runs/${end.runId}`;
    const list = readEvents(end.dir);
    const released = list.find((event) => event.type === 'workspace:released');
    const last = list.at(-1);
    expect({
      status: end.status,
      released: released?.type === 'workspace:released' ? { ref: released.ref, head: released.head } : released,
      message: last?.type === 'run:end' ? last.message?.includes('refs/sail/runs/') : last?.type,
      kept: repo.git('log', '--format=%s', `main..${ref}`).split('\n')[0],
      issues: validateRunDir(end.dir).issues.map(formatIssue),
      worktrees: worktrees(repo),
    }).toEqual({
      status: 'failed',
      released: { ref, head: repo.git('rev-parse', ref) },
      message: false,
      kept: expect.stringMatching(/^implement \d+$/),
      issues: [],
      worktrees: [],
    });
  });
});

test("a run whose workspace can't be removed still releases its lease, and its run:end says which workspace it left", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    // Read-only once publish#1 is journaled: git can't take the worktree's files out of it, and neither can rm.
    const jam: Consumer = {
      name: 'jam',
      onEvent: (event) => {
        if (event.type === 'journal:append' && event.key === 'publish#1') {
          chmodSync(join(repo.dir, '.sail-runs', event.runId, 'workspace'), 0o555);
        }
      },
    };
    let end: RunEnd | undefined;
    try {
      end = await ran(repo.dir, { consumers: [jam] });
    } finally {
      for (const id of runIds(repo.dir)) {
        const path = join(repo.dir, '.sail-runs', id, 'workspace');
        if (existsSync(path)) chmodSync(path, 0o755);
      }
    }
    const last = readEvents(end.dir).at(-1);
    expect({
      status: end.status,
      message: last?.type === 'run:end' ? last.message?.replace(/: .*$/s, '') : last?.type,
      lease: readLease(leasesOf(repo.dir), REMOTE, BRANCH) ?? null,
    }).toEqual({
      status: 'completed',
      message: `its workspace at .sail-runs/${end.runId}/workspace was not released`,
      lease: null,
    });
  });
});

test("a run whose lease can't be released still ends with run:end, which says so, and its workspace is gone (review #1.10)", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    // Once publish#1 is journaled, the lease file holds what no lease is.
    const spoil: Consumer = {
      name: 'spoil',
      onEvent: (event) => {
        if (event.type === 'journal:append' && event.key === 'publish#1') {
          const dir = leasesOf(repo.dir);
          for (const name of readdirSync(dir)) writeFileSync(join(dir, name), 'no lease\n');
        }
      },
    };
    const end = await ran(repo.dir, { consumers: [spoil] });
    const last = readEvents(end.dir).at(-1);
    expect({
      status: end.status,
      message: last?.type === 'run:end' ? last.message?.replace(/: .*$/s, '') : last?.type,
      workspace: existsSync(join(end.dir, 'workspace')),
    }).toEqual({
      status: 'completed',
      message: `its lease on ${BRANCH} was not released`,
      workspace: false,
    });
  });
});

test.skipIf(process.getuid?.() === 0)(
  "a run whose lease directory became read-only still ends with run:end, which says its lease wasn't released",
  async () => {
    await withTempRepo(async (repo) => {
      writeStub(repo.dir, { testsPassAt: 1 });
      const lock: Consumer = {
        name: 'lock',
        onEvent: (event) => {
          if (event.type === 'journal:append' && event.key === 'publish#1') chmodSync(leasesOf(repo.dir), 0o555);
        },
      };
      let end: RunEnd | undefined;
      try {
        end = await ran(repo.dir, { consumers: [lock] });
      } finally {
        chmodSync(leasesOf(repo.dir), 0o755);
      }
      const last = readEvents(end.dir).at(-1);
      const message = last?.type === 'run:end' ? last.message : last?.type;
      expect(end.status).toBe('completed');
      expect(message).toContain(`its lease on ${BRANCH} was not released: workspace.lease:`);
      expect(message).toContain('EACCES');
    });
  },
);

test('a start whose lease file is a directory is refused as unavailable, and leaves no run directory', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    mkdirSync(leaseFile(leasesOf(repo.dir), REMOTE, BRANCH), { recursive: true });
    const end = await runWorkflow({
      cwd: repo.dir,
      adapters: await fakeAdapters(repo.dir),
      workflow: 'ticket-to-pr',
      ticket: 'FAKE-1',
    });
    const refused = 'refused' in end ? end.refused : `ran: ${end.status}`;
    expect(refused).toContain(`the branch ${BRANCH} could not be leased`);
    expect(refused).toContain('EISDIR');
    expect(refused).toContain('(unavailable)');
    expect(runIds(repo.dir)).toEqual([]);
  });
});

test.each<[string, 'completed' | 'running']>([
  ['whose run completed', 'completed'],
  ['whose run was running in a process now gone', 'running'],
])('a stale lease %s is taken over, and workspace:leased names the run it took from', async (_, status) => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const gone = join(repo.dir, '.sail-runs', 'FAKE-1-GONE');
    mkdirSync(gone, { recursive: true });
    writeStatus(gone, status);
    const exited = Bun.spawn(['true']);
    await exited.exited;
    takeLease(leasesOf(repo.dir), REMOTE, BRANCH, { runId: 'FAKE-1-GONE', runDir: gone, pid: exited.pid });
    const end = await ran(repo.dir, { until: 'spec' });
    const leased = readEvents(end.dir).find((event) => event.type === 'workspace:leased');
    expect({ leased, holder: readLease(leasesOf(repo.dir), REMOTE, BRANCH)?.runId }).toEqual({
      leased: expect.objectContaining({ remote: REMOTE, branch: BRANCH, took: 'FAKE-1-GONE' }),
      holder: end.runId,
    });
  });
});

// Steps run in the workspace, and record paths relative to the repository.

test("a run's script steps run in its worktree, on its branch, and the clone's checkout is left as it was", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    before(
      sail,
      SPEC_SCRIPT,
      SPEC_BODY,
      'printf \'%s\\n\' "$(pwd)" "$WORKSPACE" "$BRANCH" "$(git rev-parse --show-toplevel)" >"$STUB/where.txt"\necho new >"$WORKSPACE/new.txt"',
    );
    writeFileSync(join(repo.dir, '.gitignore'), '.sail-runs/\n.stub/\n');
    repo.git('add', '-A', '.sail', '.gitignore');
    repo.git('commit', '-q', '-m', 'the stub');
    const status = repo.git('status', '--porcelain');
    const end = await ran(repo.dir, { until: 'spec' });
    const workspace = existsSync(join(end.dir, 'workspace')) ? realpathSync(join(end.dir, 'workspace')) : 'none';
    const where = textOf(join(repo.dir, '.stub', 'where.txt'))
      .trimEnd()
      .split('\n');
    expect({
      where,
      written: [existsSync(join(workspace, 'new.txt')), existsSync(join(repo.dir, 'new.txt'))],
      status: repo.git('status', '--porcelain'),
    }).toEqual({
      where: [workspace, workspace, BRANCH, workspace],
      written: [true, false],
      status,
    });
  });
});

test("result.json and script:exec record the workspace and the branch, with every path relative to the repository's root", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const end = await ran(repo.dir, { until: 'spec' });
    const result = resultOf(end.dir, '01-spec/call-1');
    const exec = readEvents(end.dir).find((event) => event.type === 'script:exec');
    const env = result.env as Record<string, string>;
    expect({
      command: result.command,
      env: { WORKSPACE: env.WORKSPACE, BRANCH: env.BRANCH, SAIL_CONFIG: env.SAIL_CONFIG },
      exec: exec?.type === 'script:exec' ? { cwd: exec.cwd, branch: exec.envKeys.includes('BRANCH') } : exec,
    }).toEqual({
      command: '.sail/workflows/ticket-to-pr/stages/spec/run.sh',
      env: { WORKSPACE: `.sail-runs/${end.runId}/workspace`, BRANCH, SAIL_CONFIG: '.sail/project.yaml' },
      exec: { cwd: `.sail-runs/${end.runId}/workspace`, branch: true },
    });
  });
});

test("an agent step's session runs in the run's worktree, with BRANCH in its environment", async () => {
  await withTempRepo(async (repo) => {
    writeAgentFixture(repo.dir, [submits(SPEC, 0.25)]);
    const adapters = await fakeAdapters(repo.dir);
    const asked: HarnessRequest[] = [];
    const { harness } = adapters.ports;
    const run = harness.run.bind(harness);
    harness.run = (request) => {
      asked.push(request);
      return run(request);
    };
    const end = await ran(repo.dir, { workflow: AGENT_WORKFLOW, adapters });
    const [spec] = asked;
    expect({ cwd: spec?.cwd, branch: spec?.env.BRANCH, workspace: spec?.env.WORKSPACE }).toEqual({
      cwd: join(end.dir, 'workspace'),
      branch: 'sail/FAKE-1-add-a-shout-flag',
      workspace: join(end.dir, 'workspace'),
    });
  });
});

// gitDiff() bindings: resolved from the workspace just before the call.

/** The stub, with `tests` consuming the run's diff as `diff`, and an optional diff since main as `since`. */
function stubConsumingDiff(repo: TempRepo, range = 'main...HEAD'): string {
  const sail = writeStub(repo.dir, { testsPassAt: 1 });
  edit(
    sail,
    'stages/tests/stage.ts',
    "import { script, z } from 'sail';",
    "import { gitDiff, script, z } from 'sail';",
  );
  edit(
    sail,
    'stages/tests/stage.ts',
    "  run: './run.sh',",
    `  run: './run.sh',\n  consumes: { diff: gitDiff('${range}'), since: gitDiff('main').optional() },`,
  );
  before(
    sail,
    IMPLEMENT_SCRIPT,
    IMPLEMENT_BODY,
    'echo "an edit" >>"$WORKSPACE/README.md"\nmkdir -p "$WORKSPACE/src"\necho "export const made = true;" >"$WORKSPACE/src/made.ts"',
  );
  before(sail, TESTS_SCRIPT, TESTS_BODY, 'cp "$INPUT_DIFF" "$STUB/diff-$CALL.patch"');
  return sail;
}

/** The files a patch writes. */
const patched = (patch: string) => [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]).sort();

test("a stage consuming gitDiff('main...HEAD') finds the run's patch in $STAGE_IN, a tracked edit and a new file, and an optional gitDiff binding is resolved too", async () => {
  await withTempRepo(async (repo) => {
    stubConsumingDiff(repo);
    const end = await ran(repo.dir, { until: 'tests' });
    const seen = textOf(join(repo.dir, '.stub', 'diff-1.patch'));
    const result = resultOf(end.dir, '03-tests/call-1');
    const materialised = readEvents(end.dir).flatMap((event) =>
      event.type === 'input:materialised' && event.key === 'tests#1' ? [`${event.binding} ← ${event.from}`] : [],
    );
    expect({
      files: patched(seen),
      copy: textOf(join(end.dir, '03-tests', 'call-1', 'in', 'diff.patch')) === seen,
      since: patched(textOf(join(end.dir, '03-tests', 'call-1', 'in', 'since.patch'))),
      consumed: result.consumed,
      materialised,
    }).toEqual({
      files: ['README.md', 'src/made.ts'],
      copy: true,
      since: ['README.md', 'src/made.ts'],
      consumed: { diff: 'gitDiff(main...HEAD)', since: 'gitDiff(main)' },
      materialised: ['diff ← gitDiff(main...HEAD)', 'since ← gitDiff(main)'],
    });
  });
});

test("a stage of one step whose step consumes gitDiff('main...HEAD') finds the run's patch in $STAGE_IN, as the step alone does (review R1-6)", async () => {
  await withTempRepo(async (repo) => {
    const sail = stubConsumingDiff(repo);
    edit(
      sail,
      'stages/tests/stage.ts',
      "import { gitDiff, script, z } from 'sail';",
      "import { gitDiff, script, stage, z } from 'sail';",
    );
    edit(sail, 'stages/tests/stage.ts', "export const tests = script('tests', {", "const run = script('run', {");
    writeFileSync(
      join(sail, 'stages/tests/stage.ts'),
      `${textOf(join(sail, 'stages/tests/stage.ts'))}\nexport const tests = stage('tests', { produces: { 'junit.xml': 'file' }, output: TestReport, steps: [run] });\n`,
    );
    const end = await ran(repo.dir, { until: 'tests' });
    const result = resultOf(end.dir, '03-tests/call-1');
    expect([result.key, result.consumed]).toEqual([
      'tests#1',
      { diff: 'gitDiff(main...HEAD)', since: 'gitDiff(main)' },
    ]);
    expect(patched(textOf(join(end.dir, '03-tests', 'call-1', 'in', 'diff.patch')))).toEqual([
      'README.md',
      'src/made.ts',
    ]);
  });
});

test('a gitDiff range the workspace refuses fails the run with workflow_failed, naming the binding, and the call is never written', async () => {
  await withTempRepo(async (repo) => {
    stubConsumingDiff(repo, 'main..HEAD');
    const end = await ran(repo.dir);
    expect({
      status: end.status,
      stopReason: end.stopReason,
      message: end.message?.replace(/: '[^']*' is not a range.*$/s, ': …'),
      written: existsSync(join(end.dir, '03-tests')),
    }).toEqual({
      status: 'failed',
      stopReason: 'workflow_failed',
      message: "tests#1 can't run: 'diff': workspace.diff: …",
      written: false,
    });
  });
});

test('a resumed run takes the diff afresh for its first call that is not journaled', async () => {
  await withTempRepo(async (repo) => {
    const runId = await withTempRepo(async (from) => {
      stubConsumingDiff(from);
      const end = await ran(from.dir, { until: 'implement' });
      copyRun(from.dir, repo.dir);
      return end.runId;
    });
    const dir = join(repo.dir, '.sail-runs', runId);
    if (existsSync(join(dir, 'workspace'))) {
      writeFileSync(join(dir, 'workspace', 'after.txt'), 'made while the run was suspended\n');
    }
    const end = await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId });
    expect({
      status: 'status' in end ? end.status : end,
      files: patched(textOf(join(dir, '03-tests', 'call-1', 'in', 'diff.patch'))),
    }).toEqual({ status: 'completed', files: ['README.md', 'after.txt', 'src/made.ts'] });
  });
});

/** A run's `workspace:created` base and `codehost:pushed` head and branch, and how many `error:*` events it holds. */
function startAndPush(runDir: string) {
  const events = readEvents(runDir);
  return {
    base: (events.find((event) => event.type === 'workspace:created') as { baseSha: string } | undefined)?.baseSha,
    pushed: events.find((event) => event.type === 'codehost:pushed') as { headSha: string; branch: string } | undefined,
    errors: events.filter((event) => event.type.startsWith('error:')).length,
  };
}

/** Moves `refs/heads/<branch>` in `repo`, which stands in for the remote, to a commit past main: what an earlier run's push left. */
function pushedAhead(repo: TempRepo, branch: string): string {
  const sha = repo.git('commit-tree', 'main^{tree}', '-p', 'main', '-m', 'work an earlier run pushed');
  repo.git('update-ref', `refs/heads/${branch}`, sha);
  return sha;
}

const rerunSource = sharedSource();
afterAll(() => rerunSource.release());

test('a second run of a ticket whose first run pushed its branch starts from that branch and completes, its push fast-forward', async () => {
  await withTempRepo(async (repo) => {
    const from = await rerunSource.copyInto(repo.dir);
    const first = startAndPush(from.dir);
    const tip = pushedAhead(repo, first.pushed?.branch ?? '');
    const second = await runCaptured(['FAKE-1', '--force'], repo.dir, { env: repo.env });
    const [, rerunId = ''] = runIds(repo.dir).sort();
    const rerun = startAndPush(join(repo.dir, '.sail-runs', rerunId));
    expect(second.code).toBe(EXIT_OK);
    expect(tip).not.toBe(repo.git('rev-parse', 'main'));
    expect({
      base: rerun.base,
      branch: rerun.pushed?.branch,
      head: rerun.pushed?.headSha,
      errors: rerun.errors,
    }).toEqual({
      base: tip,
      branch: first.pushed?.branch,
      head: tip,
      errors: 0,
    });
  });
}, 60_000);

test('a resume of a rerun reopens at the baseSha run.json recorded', async () => {
  let rerunId = '';
  await withTempRepo(async (to) => {
    await withTempRepo(async (from) => {
      const source = await rerunSource.copyInto(from.dir);
      const pushed = pushedAhead(from, startAndPush(source.dir).pushed?.branch ?? '');
      const stop = new AbortController();
      const interrupted = await runWorkflow({
        cwd: from.dir,
        adapters: await fakeAdapters(from.dir),
        workflow: 'ticket-to-pr',
        ticket: 'FAKE-1',
        force: true,
        signal: stop.signal,
        onCall: () => stop.abort(),
      });
      if ('refused' in interrupted) throw new Error(`refused: ${interrupted.refused}`);
      rerunId = interrupted.runId;
      const recorded = JSON.parse(readFileSync(join(interrupted.dir, 'run.json'), 'utf8')).repository.baseSha;
      expect({ status: interrupted.status, recorded }).toEqual({ status: 'suspended', recorded: pushed });
      copyRun(from.dir, to.dir);
    });
    const resumed = await resumeWorkflow({ cwd: to.dir, adapters: await fakeAdapters(to.dir), runId: rerunId });
    if ('refused' in resumed) throw new Error(`refused: ${resumed.refused}`);
    const created = readEvents(resumed.dir).filter((event) => event.type === 'workspace:created');
    expect({ status: resumed.status, created: created.length }).toEqual({ status: 'completed', created: 1 });
  });
}, 90_000);
