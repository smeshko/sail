// `sail queue ls|add|requeue|drop|poll` (DECISIONS D8, D9): the refusals and `ls` through run(), with no watcher; the
// changes against a watcher running in process on fake timers and a fake spawner, handed in through the commands' deps,
// as test/cli/watch.test.ts runs one. Each case has a temp repository of its own and a registry under its own SAIL_HOME.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { queueCommand } from '../../src/cli/commands/queue';
import { type WatchDeps, watchCommand } from '../../src/cli/commands/watch';
import { EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import type { Io } from '../../src/cli/index';
import { parkedCommands } from '../../src/dashboard/page/commands';
import { commandsDir } from '../../src/watch/inbox';
import { queueDir } from '../../src/watch/queue-store';
import { readEntry } from '../../src/watch/registry';
import { fakeTimers } from '../helpers/fake-timers';
import { writePrWorkflow } from '../helpers/pr-workflow';
import { queueEvents } from '../helpers/queue';
import { fakeInterrupts, runCaptured } from '../helpers/run-captured';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';
import { fakeSpawner, type SeedTicket, writeTickets, writeWatched } from '../helpers/watched';

const START = '2026-10-15T09:00:00.000Z';
/** The pid an in-process watcher records itself under: not this process's, which a second command runs in. */
const WATCHER_PID = 4242;
const RUN = 'FAKE-2-01M3BWNZM08Q4T6V2XRJ5KWD3N';

/** The stub with a (sail-a, cap 1) and b (sail-b, cap 1), the tickets given, and a SAIL_HOME. */
function repository(repo: TempRepo, tickets: SeedTicket[]) {
  const sail = writeStub(repo.dir);
  writeWatched(sail, 'a', { label: 'sail-a', cap: 1 });
  writeWatched(sail, 'b', { label: 'sail-b', cap: 1 });
  writeTickets(sail, tickets);
  const sailHome = join(repo.home, 'sail-home');
  return { sail, env: { ...repo.env, SAIL_HOME: sailHome }, registry: join(sailHome, 'watchers') };
}

const designated = (...keys: string[]): SeedTicket[] => keys.map((key) => ({ key, labels: ['sail-a'] }));

/** An Io for a command run in `cwd`, collecting what it prints. */
function io(cwd: string, env: NonNullable<Io['env']>, onInterrupt?: Io['onInterrupt']) {
  const printed = { stdout: '', stderr: '' };
  const handle: Io = {
    cwd,
    env,
    stdout: (text) => {
      printed.stdout += text;
    },
    stderr: (text) => {
      printed.stderr += text;
    },
    ...(onInterrupt === undefined ? {} : { onInterrupt }),
  };
  return { io: handle, printed };
}

/**
 * Waits up to 5 s of real time for a command file to be dropped in `runsDir`'s inbox, or for the command to have ended
 * without dropping one.
 */
async function commandDropped(runsDir: string, ended: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  const dropped = () =>
    existsSync(commandsDir(runsDir)) && readdirSync(commandsDir(runsDir)).some((name) => name.endsWith('.json'));
  while (!dropped() && !ended()) {
    if (performance.now() > deadline) throw new Error('no command was dropped within 5 s');
    await Bun.sleep(5);
  }
}

/** A watcher of a running in process from `repo` on fake timers, under WATCHER_PID, and `sail queue` beside it. */
async function running(repo: TempRepo, tickets: SeedTicket[], extra?: (sail: string) => string) {
  const world = repository(repo, tickets);
  const also = extra?.(world.sail);
  const runs = join(repo.dir, '.sail-runs');
  const timers = fakeTimers(START);
  const spawner = fakeSpawner(runs);
  const isAlive = (pid: number) => pid === WATCHER_PID || spawner.isAlive(pid);
  const deps: WatchDeps = {
    timers,
    now: timers.now,
    spawn: spawner.spawn,
    resume: spawner.resume,
    isAlive,
    pid: WATCHER_PID,
  };
  const interrupts = fakeInterrupts();
  const watcher = io(repo.dir, world.env, interrupts.onInterrupt);
  const exited = Promise.resolve(
    watchCommand(deps)({ values: {}, positionals: also === undefined ? ['a'] : ['a', also] }, watcher.io),
  );
  const deadline = performance.now() + 10_000;
  while (readEntry(world.registry, 'stub')?.watcher === undefined && performance.now() < deadline) {
    await Bun.sleep(5);
  }
  const queue = (argv: string[], force = false) => {
    const other = io(repo.dir, world.env);
    const values: Record<string, boolean | string> = force ? { force: true } : {};
    const positionals: string[] = [];
    for (let at = 0; at < argv.length; at += 1) {
      const arg = argv[at] ?? '';
      if (arg === '--before' || arg === '--after') values[arg.slice(2)] = argv[++at] ?? '';
      else positionals.push(arg);
    }
    const done = Promise.resolve(
      queueCommand({ isAlive, pollMs: 5, applyTimeoutMs: 5000 })({ values, positionals }, other.io),
    );
    return { done, printed: other.printed };
  };
  /** Runs `sail queue <argv>` beside the watcher, ticking the watcher once the command has dropped its file. */
  const applied = async (argv: string[], force = false) => {
    const { done, printed } = queue(argv, force);
    let ended = false;
    void done.then(() => {
      ended = true;
    });
    await commandDropped(runs, () => ended);
    if (!ended) await timers.advance(1000);
    return { code: await done, ...printed };
  };
  /** Runs `sail queue <argv>` beside the watcher when it is refused before it drops anything. */
  const refused = async (argv: string[], force = false) => {
    const { done, printed } = queue(argv, force);
    return { code: await done, ...printed, inbox: existsSync(commandsDir(runs)) ? readdirSync(commandsDir(runs)) : [] };
  };
  const stop = async () => {
    interrupts.interrupt();
    expect(await exited).toBe(EXIT_OK);
  };
  return { ...world, runs, timers, spawner, applied, refused, stop };
}

/** Parks the items of FAKE-1 and FAKE-2, each run stopped, and leaves FAKE-3's run in flight. */
async function parkTwo(w: Awaited<ReturnType<typeof running>>): Promise<void> {
  await w.timers.advance(1000);
  for (const key of ['FAKE-1', 'FAKE-2']) {
    await w.spawner.end(key, { status: 'failed', stopReason: 'stopped' });
    await w.timers.advance(1000);
  }
}

/** A hand-written queue for a, with an item in each state ls prints differently. */
function writeQueue(runs: string): string {
  const dir = queueDir(runs, 'a');
  mkdirSync(dir, { recursive: true });
  const item = (key: string, title: string, fields: Record<string, unknown>) => ({
    dedupKey: `ticket:${key}`,
    source: { kind: 'ticket', ticketKey: key },
    title,
    url: `fake://tickets/${key}`,
    attempts: 0,
    addedAt: START,
    ...fields,
  });
  const queue = {
    version: 1,
    workflow: 'a',
    updatedAt: START,
    polling: {
      label: 'sail-a',
      failures: 0,
      lastPolledAt: START,
      paused: { port: 'ticketSource', adapter: 'fake', code: 'unauthorized', message: 'key expired', at: START },
    },
    items: [
      item('FAKE-1', 'Add a greeting', { state: 'queued', forced: true }),
      item('FAKE-2', 'Add a farewell', { state: 'dispatched', attempts: 1, runId: RUN, pid: 4243 }),
      item('FAKE-3', 'Say hello\u001b[31m twice', {
        state: 'failed',
        attempts: 1,
        retryAt: '2026-10-15T09:05:00.000Z',
        reason: `run ${RUN} failed (stage_error)`,
      }),
      item('FAKE-4', 'Document it', { state: 'parked', attempts: 2, runId: RUN, reason: 'spec blocked' }),
    ],
  };
  const path = join(dir, 'queue.json');
  writeFileSync(path, `${JSON.stringify(queue, null, 2)}\n`);
  return path;
}

test('sail queue with no operation, an unknown one, no workflow, a workflow that is no name, no item or ticket, an extra argument, or --force on anything but add exits 3 saying which', async () => {
  await withTempRepo(async (repo) => {
    const { env } = repository(repo, []);
    const cases: string[][] = [
      ['queue'],
      ['queue', 'list', 'a'],
      ['queue', 'ls'],
      ['queue', 'ls', 'A/b'],
      ['queue', 'requeue', 'a'],
      ['queue', 'add', 'a'],
      ['queue', 'poll', 'a', 'FAKE-1'],
      ['queue', 'drop', 'a', 'FAKE-1', '--force'],
    ];
    const results = [];
    for (const argv of cases) results.push(await runCaptured(argv, repo.dir, { env }));
    expect(results.map(({ code, stderr }) => ({ code, stderr }))).toEqual(
      [
        'name an operation: ls, add, requeue, drop, poll, move',
        "unknown operation 'list': the operations are ls, add, requeue, drop, poll, move",
        'name the workflow: sail queue ls <workflow>',
        "'A/b' is not a workflow's name: sail queue ls <workflow>",
        'name the item: sail queue requeue <workflow> <item>',
        'name the ticket: sail queue add <workflow> <ticket> [--force]',
        "unknown argument 'FAKE-1': sail queue poll <workflow>",
        '--force belongs to sail queue add: sail queue drop <workflow> <item>',
      ].map((message) => ({ code: EXIT_REFUSED, stderr: `sail queue: ${message}\n` })),
    );
  });
});

test("sail queue ls a with no watcher prints the queue's polling, then each item with what applies to it, and a workflow with no queue exits 3", async () => {
  await withTempRepo(async (repo) => {
    const { env } = repository(repo, []);
    writeQueue(join(repo.dir, '.sail-runs'));
    const listed = await runCaptured(['queue', 'ls', 'a'], repo.dir, { env });
    const none = await runCaptured(['queue', 'ls', 'b'], repo.dir, { env });
    expect([listed, none]).toEqual([
      {
        code: EXIT_OK,
        stdout: [
          `a: label sail-a, last polled ${START}, paused: key expired`,
          'queued ticket:FAKE-1 Add a greeting · forced',
          `dispatched ticket:FAKE-2 Add a farewell · run ${RUN}, 1 attempt`,
          `failed ticket:FAKE-3 Say hello twice · 1 attempt, retry at 2026-10-15T09:05:00.000Z, run ${RUN} failed (stage_error)`,
          `parked ticket:FAKE-4 Document it · run ${RUN}, 2 attempts, spec blocked`,
          '',
        ].join('\n'),
        stderr: '',
      },
      {
        code: EXIT_REFUSED,
        stdout: '',
        stderr: "sail queue: no queue for 'b' in .sail-runs/queue: it has never been watched\n",
      },
    ]);
  });
});

test('with no watcher running, requeue, drop, add and poll exit 3 naming sail watch, drop no command, and leave queue.json byte for byte', async () => {
  await withTempRepo(async (repo) => {
    const { env } = repository(repo, designated('FAKE-9'));
    const runs = join(repo.dir, '.sail-runs');
    const path = writeQueue(runs);
    const before = readFileSync(path, 'utf8');
    const results = [];
    for (const argv of [
      ['queue', 'requeue', 'a', 'ticket:FAKE-4'],
      ['queue', 'drop', 'a', 'FAKE-4'],
      ['queue', 'add', 'a', 'FAKE-9'],
      ['queue', 'poll', 'a'],
    ]) {
      results.push(await runCaptured(argv, repo.dir, { env }));
    }
    expect({
      results,
      queue: readFileSync(path, 'utf8') === before,
      inbox: existsSync(commandsDir(runs)),
    }).toEqual({
      results: Array(4).fill({
        code: EXIT_REFUSED,
        stdout: '',
        stderr: "sail queue: no watcher is running for 'stub' here: sail watch a first\n",
      }),
      queue: true,
      inbox: false,
    });
  });
});

test('with a watcher watching a, sail queue requeue a ticket:FAKE-1 queues the parked item again, so does FAKE-2 by its ticket key, and each prints the item', async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, designated('FAKE-1', 'FAKE-2', 'FAKE-3'));
    await parkTwo(w);
    const byKey = await w.applied(['requeue', 'a', 'ticket:FAKE-1']);
    const byTicket = await w.applied(['requeue', 'a', 'FAKE-2']);
    const items = JSON.parse(readFileSync(join(queueDir(w.runs, 'a'), 'queue.json'), 'utf8')).items;
    expect({
      byKey,
      byTicket,
      items: items.map((item: Record<string, unknown>) => `${item.dedupKey} ${item.state} ${item.attempts}`),
      inbox: existsSync(commandsDir(w.runs)) ? readdirSync(commandsDir(w.runs)) : 'no inbox',
    }).toEqual({
      byKey: { code: EXIT_OK, stdout: 'sail queue: queued ticket:FAKE-1 Ticket FAKE-1\n', stderr: '' },
      byTicket: { code: EXIT_OK, stdout: 'sail queue: queued ticket:FAKE-2 Ticket FAKE-2\n', stderr: '' },
      items: ['ticket:FAKE-1 queued 0', 'ticket:FAKE-2 queued 0', 'ticket:FAKE-3 dispatched 1'],
      inbox: [],
    });
    await w.stop();
  });
}, 30_000);

test('a requeue the watcher applies and its dispatch then drops, as for a ticket left In Progress, says both, with the reason, and exits 3 (review R1-1)', async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, designated('FAKE-1', 'FAKE-2', 'FAKE-3'));
    await parkTwo(w);
    await w.spawner.end('FAKE-3');
    await w.timers.advance(1000);
    writeTickets(w.sail, [
      { key: 'FAKE-1', labels: ['sail-a'], state: { type: 'started', name: 'In Progress' } },
      ...designated('FAKE-2', 'FAKE-3'),
    ]);
    const requeued = await w.applied(['requeue', 'a', 'ticket:FAKE-1']);
    expect({
      requeued,
      events: queueEvents(queueDir(w.runs, 'a'))
        .filter((event) => event.dedupKey === 'ticket:FAKE-1')
        .map((event) => event.type)
        .slice(-2),
    }).toEqual({
      requeued: {
        code: EXIT_REFUSED,
        stdout: '',
        stderr: 'sail queue: the watcher requeued ticket:FAKE-1, then dropped it: it is In Progress\n',
      },
      events: ['queue:requeued', 'queue:dropped'],
    });
    await w.stop();
  });
}, 30_000);

test('sail queue drop a FAKE-1 drops a parked item, and a dispatched one is refused before any command is dropped', async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, designated('FAKE-1', 'FAKE-2', 'FAKE-3'));
    await parkTwo(w);
    const run3 = w.spawner.run('FAKE-3').runId;
    const refused = await w.refused(['drop', 'a', 'FAKE-3']);
    const dropped = await w.applied(['drop', 'a', 'FAKE-1']);
    expect({
      refused,
      dropped,
      events: queueEvents(queueDir(w.runs, 'a'))
        .filter((event) => event.type === 'queue:dropped')
        .map(({ dedupKey, reason }) => ({ dedupKey, reason })),
    }).toEqual({
      refused: {
        code: EXIT_REFUSED,
        stdout: '',
        stderr: `sail queue: ticket:FAKE-3 can't be dropped: its run ${run3} has not ended: sail stop ${run3} first\n`,
        inbox: [],
      },
      dropped: { code: EXIT_OK, stdout: 'sail queue: ticket:FAKE-1 dropped\n', stderr: '' },
      events: [{ dedupKey: 'ticket:FAKE-1', reason: 'dropped by hand' }],
    });
    await w.stop();
  });
}, 30_000);

test('sail queue add a FAKE-9 queues a designated, unstarted ticket; an undesignated one exits 3 naming the label, and with --force it is queued forced', async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, designated('FAKE-1'));
    await w.timers.advance(1000);
    writeTickets(w.sail, [...designated('FAKE-1', 'FAKE-9'), { key: 'FAKE-8', labels: [] }]);
    const added = await w.applied(['add', 'a', 'FAKE-9']);
    const undesignated = await w.refused(['add', 'a', 'FAKE-8']);
    const forced = await w.applied(['add', 'a', 'FAKE-8'], true);
    expect({ added, undesignated, forced }).toEqual({
      added: { code: EXIT_OK, stdout: 'sail queue: queued ticket:FAKE-9 Ticket FAKE-9\n', stderr: '' },
      undesignated: {
        code: EXIT_REFUSED,
        stdout: '',
        stderr: "sail queue: the ticket is not designated: it carries no 'sail-a' label. --force runs it anyway\n",
        inbox: [],
      },
      forced: { code: EXIT_OK, stdout: 'sail queue: queued ticket:FAKE-8 Ticket FAKE-8 · forced\n', stderr: '' },
    });
    await w.stop();
  });
}, 30_000);

test('sail queue poll a makes the watcher poll a now', async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, []);
    await w.timers.advance(1000);
    writeTickets(w.sail, designated('FAKE-9'));
    const polled = () => queueEvents(queueDir(w.runs, 'a')).filter((event) => event.type === 'queue:polled');
    const before = polled().length;
    const poll = await w.applied(['poll', 'a']);
    expect({ poll, polls: polled().length - before, last: polled().at(-1)?.added }).toEqual({
      poll: {
        code: EXIT_OK,
        stdout: `sail queue: the watcher of 'stub' (pid ${WATCHER_PID}) polls a now\n`,
        stderr: '',
      },
      polls: 1,
      last: 1,
    });
    await w.stop();
  });
}, 30_000);

test("the dashboard's commands for a parked item run as printed: its requeue queues it again, and its drop then drops it", async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, designated('FAKE-1', 'FAKE-2', 'FAKE-3'));
    await parkTwo(w);
    const [requeue, drop] = parkedCommands('a', 'ticket:FAKE-1').map(({ command }) => command.split(' '));
    expect([requeue?.slice(0, 2), drop?.slice(0, 2)]).toEqual([
      ['sail', 'queue'],
      ['sail', 'queue'],
    ]);
    const requeued = await w.applied(requeue?.slice(2) ?? []);
    const dropped = await w.applied(drop?.slice(2) ?? []);
    expect([requeued, dropped]).toEqual([
      { code: EXIT_OK, stdout: 'sail queue: queued ticket:FAKE-1 Ticket FAKE-1\n', stderr: '' },
      { code: EXIT_OK, stdout: 'sail queue: ticket:FAKE-1 dropped\n', stderr: '' },
    ]);
    await w.stop();
  });
}, 30_000);

test('sail queue add of a ticket to a pull-request workflow exits 3, naming what it polls, before any command is dropped (review R1-5)', async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, [{ key: 'FAKE-1', labels: ['sail-r'] }], (sail) => {
      writePrWorkflow(sail, 'r', { watch: { label: 'sail-r', cap: 1 } });
      return 'r';
    });
    await w.timers.advance(1000);
    expect(await w.refused(['add', 'r', 'FAKE-1'])).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: "sail queue: workflow 'r' polls pull requests: only a workflow that polls tickets takes an add\n",
      inbox: [],
    });
    await w.stop();
  });
}, 30_000);

test('sail queue ls a prints dispatch held until <time> on its first line while the queue is held, and not otherwise', async () => {
  await withTempRepo(async (repo) => {
    const { env } = repository(repo, []);
    const path = writeQueue(join(repo.dir, '.sail-runs'));
    const plain = await runCaptured(['queue', 'ls', 'a'], repo.dir, { env });
    const queue = JSON.parse(readFileSync(path, 'utf8'));
    const held = { until: '2026-10-28T14:20:00.000Z', runId: RUN, reason: 'spec#1 hit the usage limit', at: START };
    writeFileSync(path, `${JSON.stringify({ ...queue, held })}\n`);
    const listed = await runCaptured(['queue', 'ls', 'a'], repo.dir, { env });
    expect(plain.stdout.split('\n')[0]).toBe(`a: label sail-a, last polled ${START}, paused: key expired`);
    expect(listed.stdout.split('\n')[0]).toBe(
      `a: label sail-a, last polled ${START}, paused: key expired, dispatch held until 2026-10-28T14:20:00.000Z`,
    );
  });
});

test('sail queue move a FAKE-3 --before FAKE-2, with the watcher live, puts the item first among the queued, prints it as moved, and exits 0', async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, designated('FAKE-1', 'FAKE-2', 'FAKE-3'));
    await w.timers.advance(1000);
    const moved = await w.applied(['move', 'a', 'FAKE-3', '--before', 'FAKE-2']);
    const items = JSON.parse(readFileSync(join(queueDir(w.runs, 'a'), 'queue.json'), 'utf8')).items;
    const back = await w.applied(['move', 'a', 'ticket:FAKE-3', '--after', 'ticket:FAKE-2']);
    expect({
      moved,
      items: items.map((item: Record<string, unknown>) => `${item.dedupKey} ${item.state}`),
      back,
    }).toEqual({
      moved: { code: EXIT_OK, stdout: 'sail queue: queued ticket:FAKE-3 Ticket FAKE-3 · moved\n', stderr: '' },
      items: ['ticket:FAKE-1 dispatched', 'ticket:FAKE-3 queued', 'ticket:FAKE-2 queued'],
      back: { code: EXIT_OK, stdout: 'sail queue: queued ticket:FAKE-3 Ticket FAKE-3 · moved\n', stderr: '' },
    });
    await w.stop();
  });
}, 30_000);

test('sail queue move a FAKE-2 --after FAKE-3 puts the item directly after its target in the queue file (review R6)', async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, designated('FAKE-1', 'FAKE-2', 'FAKE-3'));
    await w.timers.advance(1000);
    const moved = await w.applied(['move', 'a', 'FAKE-2', '--after', 'FAKE-3']);
    const items = JSON.parse(readFileSync(join(queueDir(w.runs, 'a'), 'queue.json'), 'utf8')).items;
    expect({
      code: moved.code,
      items: items.map((item: Record<string, unknown>) => `${item.dedupKey} ${item.state}`),
    }).toEqual({
      code: EXIT_OK,
      items: ['ticket:FAKE-1 dispatched', 'ticket:FAKE-3 queued', 'ticket:FAKE-2 queued'],
    });
    await w.stop();
  });
}, 30_000);

test('sail queue move is refused with exit 3 before any command is dropped: neither or both of --before and --after, either on another operation, an item or target not queued or unknown, or the item itself as target', async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, designated('FAKE-1', 'FAKE-2', 'FAKE-3'));
    await w.timers.advance(1000);
    const cases: string[][] = [
      ['move', 'a', 'FAKE-3'],
      ['move', 'a', 'FAKE-3', '--before', 'FAKE-2', '--after', 'FAKE-2'],
      ['drop', 'a', 'FAKE-3', '--before', 'FAKE-2'],
      ['move', 'a', 'FAKE-1', '--before', 'FAKE-2'],
      ['move', 'a', 'FAKE-3', '--after', 'FAKE-1'],
      ['move', 'a', 'FAKE-3', '--after', 'FAKE-9'],
      ['move', 'a', 'FAKE-3', '--after', 'ticket:FAKE-3'],
    ];
    const results = [];
    for (const argv of cases) results.push(await w.refused(argv));
    expect(results.map(({ code, stdout, stderr, inbox }) => ({ code, stdout, stderr, inbox }))).toEqual(
      [
        'name exactly one of --before and --after: sail queue move <workflow> <item> --before <item> | --after <item>',
        'name exactly one of --before and --after: sail queue move <workflow> <item> --before <item> | --after <item>',
        '--before and --after belong to sail queue move: sail queue drop <workflow> <item>',
        'ticket:FAKE-1 is dispatched: only a queued item is moved',
        'ticket:FAKE-1 is dispatched: only a queued item is moved',
        "a's queue has no item FAKE-9",
        "ticket:FAKE-3 can't be moved next to itself",
      ].map((message) => ({ code: EXIT_REFUSED, stdout: '', stderr: `sail queue: ${message}\n`, inbox: [] })),
    );
    await w.stop();
  });
}, 30_000);

test('with no watcher running, sail queue move exits 3 naming sail watch, and drops no command', async () => {
  await withTempRepo(async (repo) => {
    const { env } = repository(repo, []);
    const runs = join(repo.dir, '.sail-runs');
    const path = writeQueue(runs);
    const queue = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(
      path,
      `${JSON.stringify({ ...queue, items: [queue.items[0], { ...queue.items[0], dedupKey: 'ticket:FAKE-5' }] })}\n`,
    );
    const result = await runCaptured(['queue', 'move', 'a', 'FAKE-1', '--before', 'FAKE-5'], repo.dir, { env });
    expect({ result, inbox: existsSync(commandsDir(runs)) }).toEqual({
      result: {
        code: EXIT_REFUSED,
        stdout: '',
        stderr: "sail queue: no watcher is running for 'stub' here: sail watch a first\n",
      },
      inbox: false,
    });
  });
});

test('sail queue ls a prints priority <name> for an item with one other than none, and moved for a moved item', async () => {
  await withTempRepo(async (repo) => {
    const { env } = repository(repo, []);
    const path = writeQueue(join(repo.dir, '.sail-runs'));
    const queue = JSON.parse(readFileSync(path, 'utf8'));
    const [first, ...rest] = queue.items;
    const items = [
      { ...first, priority: 'urgent', moved: true },
      ...rest.map((item: object) => ({ ...item, priority: 'none' })),
    ];
    writeFileSync(path, `${JSON.stringify({ ...queue, items })}\n`);
    const listed = await runCaptured(['queue', 'ls', 'a'], repo.dir, { env });
    expect(listed.stdout.split('\n').slice(1, 3)).toEqual([
      'queued ticket:FAKE-1 Add a greeting · priority urgent, forced, moved',
      `dispatched ticket:FAKE-2 Add a farewell · run ${RUN}, 1 attempt`,
    ]);
  });
});
