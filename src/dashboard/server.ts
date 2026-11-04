// The dashboard's server: the registry's run files and queues, read-only but for a few requests, on 127.0.0.1. Every
// request passes the guard first:
//
// 1. `Host` must be this server's (`127.0.0.1:<port>` or `localhost:<port>`), so a DNS-rebinding page gets 403.
// 2. Only GET: anything else is 405, OPTIONS included, so a cross-origin preflight fails. The one exception is a POST to
//    `/api/repos/<repo>/queues/<workflow>/move`, and two more, `/api/repos/<repo>/runs/<run>/resume` and `…/restart`.
//    Each needs the client header (403), `Content-Type: application/json` (415) and an `Origin` that is absent or this
//    server's own (403). A move never writes a queue: it drops a move command in the watcher's inbox, as `sail queue
//    move` does, and answers 409 when no watcher of that clone watches it. So do four more, at
//    `/api/repos/<repo>/queues/<workflow>/poll` (body `{}`), `…/add` (`{ ticketKey, force? }`), `…/requeue` and
//    `…/drop` (`{ dedupKey }`): each makes the checks `sail queue` makes (src/watch/queue-commands.ts), 409 with its
//    message when one fails, drops the command, and waits up to 15 s for the watcher to take it. Once applied it
//    answers 200 `{ message }` with the line `sail queue` prints; a command not taken in time is 202 `{ waiting }`, and one
//    taken but not applied 409. A resume or a restart checks again what the
//    run offers (src/dashboard/actions.ts), then starts `sail resume <run>` or `sail run --from-run <run> --stage …`
//    itself, detached in the clone, its output in `.sail-runs/dashboard/<run id>.log`, as a typed command would: it
//    needs no watcher and skips the watcher's cap. It answers 202 once the run has started, or 409 with the line the
//    start was refused with. The last two are `…/runs/<run>/stop` (body `{ now }`) and `…/clean` (`{}`): each calls the
//    engine function `sail stop` or `sail clean` calls (src/engine/stop.ts, src/engine/clean.ts) in this process,
//    with the clone's Workspace port, and is refused in the same words, 409. A stop answers 202 `{ message }`, since a
//    running run ends later, and a clean 200 `{ message, removed, archived }`; a clean whose removal failed is 409
//    with the failures, and its run directory stays. The watch set is changed at `/api/repos/<repo>/watch` and
//    `…/unwatch` (body `{ workflows: string[] }`, none meaning all): each runs `sail watch` or `sail unwatch` in the
//    clone and passes the CLI's line and refusals through. A watch with no live watcher starts one, detached, its
//    output in `.sail-runs/dashboard/watcher.log`, and answers 202 `{ message, pid }` once the registry records it; any
//    other change logs to `watch-set.log` and answers 200 `{ message, workflows }`, 202 `{ waiting }` when the command
//    is not taken yet, or 409 with the CLI's refusal.
// 3. A WebSocket upgrade needs a same-origin `Origin`, or no `Origin` and the client header: browsers can't set headers
//    on an upgrade, but always send `Origin`.
// 4. A GET of exactly `/` is the page, which a navigation fetches with no header of its own. It holds no data: all it
//    shows comes over `/api` and `/ws`, under the checks above and below.
// 5. Any other request needs `X-Sail-Dashboard: 1`, which a cross-origin page can't send without a preflight.
//
// No answer carries a CORS header. Errors are JSON, `{ "error": "…" }`.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { z } from 'zod';
import { BUILTINS } from '../adapters/index';
import { resolveAdapters } from '../engine/adapters';
import { isPlainName } from '../engine/call-dir';
import { cleanedMessage, cleanRun } from '../engine/clean';
import { readConfig } from '../engine/config';
import { credentialValues } from '../engine/redact';
import { readStatus, runsDir } from '../engine/run-dir';
import { RUN_HEADER_FILE, readRunHeader } from '../engine/run-header';
import { newRunId } from '../engine/run-id';
import { formatIssue } from '../engine/schemas';
import { stoppedMessage, stopRun } from '../engine/stop';
import type { TicketSource } from '../ports/ticket-source';
import { commandTaken, dropCommand, NOT_TAKEN } from '../watch/inbox';
import { commandFor, itemLine, outcomeOf, streamMark } from '../watch/queue-commands';
import { queueItemsNaming, startingRun } from '../watch/queue-store';
import { liveSet, liveWatcher, type RegistryEntry } from '../watch/registry';
import { lastLine, type SpawnedRun, spawnDetached } from '../watch/spawn';
import { runActions } from './actions';
import { clonePorts, type ResolveClonePorts } from './clone-ports';
import { callFile, containedFile, findRepo, findRunDir, repos, runItems } from './files';
import { renderMarkdown } from './markdown';
import { createPage } from './page';
import { findQueueDir, queueViews, readQueue } from './queues';
import { createIndexFeed, openQueueFollow, openRunStream, resolveTarget } from './streams';

export interface DashboardOptions {
  registryDir: string;
  /** 0 picks a free port. */
  port: number;
  /** How often a run stream polls its events once caught up. 200 ms by default. */
  followPollMs?: number;
  /** How often the index stream rereads the registry. 1000 ms by default. */
  indexPollMs?: number;
  /** The environment a run it starts gets, and the leases are found by. `process.env` when left out. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Where branch leases are looked up, instead of the fake workspace's or the machine's. */
  leasesDir?: string;
  /** The clone's ports, for a clean's checks and a stop or a clean itself. Resolved from its `project.yaml` when left out. */
  ports?: ResolveClonePorts;
  /** The `sail` a resume or a restart starts: this checkout's when left out. */
  cli?: readonly string[];
  /** How long a start is waited for before it is answered as under way. 120 000 ms by default. */
  startWaitMs?: number;
  /** How long a queue change waits for the watcher to take its command before it is answered as waiting. 15 000 ms by default. */
  applyTimeoutMs?: number;
  /** How often it looks. 100 ms by default. */
  applyPollMs?: number;
}

export interface Dashboard {
  url: string;
  port: number;
  stop(): Promise<void>;
}

/** The header every client sends, and its one value. */
export const CLIENT_HEADER = 'X-Sail-Dashboard';

const error = (status: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ error: message }, { status, headers });

const messageOf = (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown));

const origins = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`];

/** The one path a POST is served at: `/api/repos/<repo>/queues/<workflow>/move`. */
const MOVE_PATH = /^\/api\/repos\/[^/]+\/queues\/[^/]+\/move$/;

/** The paths a queue change is made at: `/api/repos/<repo>/queues/<workflow>/poll`, `…/add`, `…/requeue` and `…/drop`. */
const QUEUE_OP_PATH = /^\/api\/repos\/[^/]+\/queues\/[^/]+\/(poll|add|requeue|drop)$/;

const PollBody = z.strictObject({});
const AddBody = z.strictObject({ ticketKey: z.string().min(1), force: z.boolean().optional() });
const ItemBody = z.strictObject({ dedupKey: z.string().min(1) });

/** The paths a run is started at: `/api/repos/<repo>/runs/<run>/resume` and `…/restart`. */
const RESUME_PATH = /^\/api\/repos\/[^/]+\/runs\/[^/]+\/resume$/;
const RESTART_PATH = /^\/api\/repos\/[^/]+\/runs\/[^/]+\/restart$/;

/** The paths a run is stopped and cleaned at: `/api/repos/<repo>/runs/<run>/stop` and `…/clean`. */
const STOP_PATH = /^\/api\/repos\/[^/]+\/runs\/[^/]+\/stop$/;
const CLEAN_PATH = /^\/api\/repos\/[^/]+\/runs\/[^/]+\/clean$/;

/** The paths the watch set is changed at: `/api/repos/<repo>/watch` and `…/unwatch`. */
const WATCH_PATH = /^\/api\/repos\/[^/]+\/(watch|unwatch)$/;

const WatchBody = z.strictObject({ workflows: z.array(z.string().min(1)) });

const StopBody = z.strictObject({ now: z.boolean() });
const CleanBody = z.strictObject({});

const ResumeBody = z.strictObject({
  raise: z
    .union([
      z.strictObject({ usd: z.number().min(0.01).optional() }),
      z.strictObject({ minutes: z.number().min(0.01).optional() }),
    ])
    .optional(),
});

const RestartBody = z.strictObject({ stage: z.string().min(1) });

const MoveBody = z
  .strictObject({
    dedupKey: z.string().min(1),
    before: z.string().min(1).optional(),
    after: z.string().min(1).optional(),
  })
  .refine((move) => (move.before === undefined) !== (move.after === undefined), {
    message: 'give exactly one of before and after',
  });

/**
 * The repository's live watcher when it runs in this clone and watches `workflow`, with how to name it and the label it
 * polls the workflow on, or the 409 that says why not.
 */
function watchedBy(entry: RegistryEntry, workflow: string): { named: string; label: string } | Response {
  const watcher = liveWatcher(entry);
  if (watcher === undefined) {
    return error(409, `no watcher is running for '${entry.name}': sail watch ${workflow} first`);
  }
  const named = `the watcher of '${entry.name}' (pid ${watcher.pid})`;
  if (watcher.sailDir !== entry.sailDir) return error(409, `${named} runs in another clone: ${watcher.sailDir}`);
  const set = liveSet(entry.sailDir, watcher.pid).find((each) => each.workflow === workflow);
  if (set === undefined) return error(409, `${named} does not watch '${workflow}': sail watch ${workflow} first`);
  return { named, label: set.label };
}

/**
 * Asks the repository's live watcher to move a queued item, by dropping a move command in its inbox: the watcher alone
 * writes the queue. Refused unless the item and its target are both queued, and the repository's live watcher runs in
 * its `.sail/` and watches the workflow, as `sail queue move` checks.
 */
async function moveRoute(registryDir: string, segments: string[], request: Request): Promise<Response> {
  const [, , name = '', , workflow = ''] = segments;
  const entry = findRepo(registryDir, name);
  if (entry === undefined) return error(404, `no repository '${name}'`);
  const dir = findQueueDir(entry, workflow);
  if (typeof dir !== 'string') return error(404, dir.missing);
  const text = await request.text();
  let data: unknown;
  try {
    data = text.length > 4096 ? undefined : JSON.parse(text);
  } catch {
    return error(400, 'the body is not JSON');
  }
  const parsed = MoveBody.safeParse(data);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return error(400, `not a move: ${[issue?.path.join('.'), issue?.message].filter(Boolean).join(' ')}`);
  }
  const { dedupKey, before, after } = parsed.data;
  const target = before ?? after ?? '';
  if (dedupKey === target) return error(409, `${dedupKey} can't be moved next to itself`);
  const { queue, problem } = readQueue(dir);
  if (queue === undefined) return error(409, problem ?? `${workflow} has no queue yet`);
  for (const key of [dedupKey, target]) {
    const item = queue.items.find((each) => each.dedupKey === key);
    if (item === undefined) return error(409, `${workflow}'s queue has no item ${key}`);
    if (item.state !== 'queued') return error(409, `${key} is ${item.state}: only a queued item is moved`);
  }
  const watched = watchedBy(entry, workflow);
  if (watched instanceof Response) return watched;
  const file = dropCommand(runsDir(entry.sailDir), {
    op: 'move',
    workflow,
    dedupKey,
    ...(before === undefined ? { after: target } : { before: target }),
  });
  return Response.json({ file }, { status: 202 });
}

/**
 * A poll, an add, a requeue or a drop in a watched workflow's queue: the checks `sail queue` makes, then the command in
 * the live watcher's inbox, and the wait for the watcher to take it and the reading of what it did. The watcher alone
 * writes the queue.
 */
async function queueOpRoute(options: DashboardOptions, segments: string[], request: Request): Promise<Response> {
  const [, , name = '', , workflow = '', op = ''] = segments;
  const entry = findRepo(options.registryDir, name);
  if (entry === undefined) return error(404, `no repository '${name}'`);
  const dir = findQueueDir(entry, workflow);
  if (typeof dir !== 'string') return error(404, dir.missing);
  let ref: string | undefined;
  let force = false;
  if (op === 'poll') {
    const parsed = await bodyOf(request, PollBody, 'a poll');
    if (parsed instanceof Response) return parsed;
  } else if (op === 'add') {
    const parsed = await bodyOf(request, AddBody, 'an add');
    if (parsed instanceof Response) return parsed;
    ref = parsed.body.ticketKey;
    force = parsed.body.force === true;
  } else if (op === 'requeue' || op === 'drop') {
    const parsed = await bodyOf(request, ItemBody, op === 'drop' ? 'a drop' : 'a requeue');
    if (parsed instanceof Response) return parsed;
    ref = parsed.body.dedupKey;
  } else {
    return error(404, `no queue operation '${op}'`);
  }
  const watched = watchedBy(entry, workflow);
  if (watched instanceof Response) return watched;

  const { sailDir } = entry;
  const runs = runsDir(sailDir);
  const config = readConfig(sailDir);
  if ('issues' in config) return error(409, config.issues.map(formatIssue).join('; '));
  let ticketSource: TicketSource | undefined;
  if (op === 'add') {
    const resolved = await resolveAdapters({
      sailDir,
      config,
      builtins: BUILTINS,
      env: environmentOf(options),
      ports: ['ticketSource'],
    });
    if ('issues' in resolved) return error(409, resolved.issues.map(formatIssue).join('; '));
    ticketSource = resolved.ports.ticketSource;
  }
  let checked: Awaited<ReturnType<typeof commandFor>>;
  try {
    checked = await commandFor(op, {
      runs,
      sailDir,
      config,
      workflow,
      label: watched.label,
      ...(ref === undefined ? {} : { ref }),
      force,
      ...(ticketSource === undefined ? {} : { ticketSource }),
    });
  } catch (thrown) {
    return error(409, messageOf(thrown));
  }
  if ('refused' in checked) return error(409, checked.refused);
  const { command, key } = checked;

  const mark = streamMark(runs, workflow);
  const file = dropCommand(runs, command);
  const taken = await commandTaken(file, {
    ...(options.applyTimeoutMs === undefined ? {} : { timeoutMs: options.applyTimeoutMs }),
    ...(options.applyPollMs === undefined ? {} : { pollMs: options.applyPollMs }),
  });
  if (!taken) {
    const waiting = `${watched.named} ${NOT_TAKEN}: it waits in ${relative(entry.clone, file)}`;
    return Response.json({ waiting }, { status: 202 });
  }
  if (op === 'poll') return Response.json({ message: `${watched.named} polls ${workflow} now` });
  let outcome: ReturnType<typeof outcomeOf>;
  try {
    outcome = outcomeOf(runs, workflow, op, key ?? '', mark);
  } catch (thrown) {
    return error(409, messageOf(thrown));
  }
  if ('refused' in outcome) return error(409, outcome.refused);
  return Response.json({ message: outcome.applied === undefined ? `${key} dropped` : itemLine(outcome.applied) });
}

/** The run ids with a start under way: a second request for one is refused. */
interface Starts {
  options: DashboardOptions;
  underway: Set<string>;
}

/** The JSON body of `request`, or the answer that refuses it. */
async function bodyOf<T>(request: Request, schema: z.ZodType<T>, what: string): Promise<{ body: T } | Response> {
  const text = await request.text();
  let data: unknown;
  try {
    data = text.length > 4096 ? undefined : JSON.parse(text);
  } catch {
    return error(400, 'the body is not JSON');
  }
  const parsed = schema.safeParse(data);
  if (parsed.success) return { body: parsed.data };
  const [issue] = parsed.error.issues;
  return error(400, `not ${what}: ${[issue?.path.join('.'), issue?.message].filter(Boolean).join(' ')}`);
}

const runAnswers = (runId: string): StartAnswers => ({ held: () => ({ runId }), late: () => ({ runId }) });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a wait answers 202 with: once the start holds, and when the wait runs out. */
interface StartAnswers {
  held(): unknown;
  late(): unknown;
}

/**
 * Waits for the start `spawned` made: until `has()` holds, which is 202, or the child exits. An exit before `has()`
 * holds, a refusal's code 3, an internal error's or a signal's, is answered 409 with the last line it printed. A start
 * that takes longer than `startWaitMs` is 202: the child is detached and on its way.
 */
async function started(
  spawned: SpawnedRun,
  log: string,
  startWaitMs: number,
  has: () => boolean,
  answers: StartAnswers,
): Promise<Response> {
  let exit: number | null | undefined;
  spawned.exited.then((code) => {
    exit = code;
  });
  const deadline = Date.now() + startWaitMs;
  while (exit === undefined) {
    if (has()) return Response.json(answers.held(), { status: 202 });
    if (Date.now() >= deadline) return Response.json(answers.late(), { status: 202 });
    await Promise.race([sleep(100), spawned.exited]);
  }
  if (has()) return Response.json(answers.held(), { status: 202 });
  return error(409, lastLine(log, spawned.logFrom) ?? `the start exited ${exit ?? 'on a signal'}`);
}

/** The run the request names, with its repository, or the answer that refuses it. */
function runOf(registryDir: string, segments: string[]) {
  const [, , name = '', , runId = ''] = segments;
  const entry = findRepo(registryDir, name);
  if (entry === undefined) return error(404, `no repository '${name}'`);
  const dir = findRunDir(entry, runId);
  if (typeof dir !== 'string') return error(404, dir.missing);
  return { entry, runId, dir };
}

/**
 * Starts `sail resume <run>` for a suspended run, detached in its clone. A run suspended over its budget needs the
 * raise of the budget it ran out of. Answers 202 once STATUS no longer reads `suspended`.
 */
async function resumeRoute(starts: Starts, segments: string[], request: Request): Promise<Response> {
  const { options, underway } = starts;
  const found = runOf(options.registryDir, segments);
  if (found instanceof Response) return found;
  const { entry, runId, dir } = found;
  const parsed = await bodyOf(request, ResumeBody, 'a resume');
  if (parsed instanceof Response) return parsed;
  const actions = await runActions(entry, runId, {
    leasesDir: options.leasesDir,
    env: options.env,
    ports: options.ports,
  });
  const { resume } = actions;
  if (resume === undefined || !resume.enabled) {
    return error(409, resume?.why ?? actions.why ?? `run ${runId} offers no resume`);
  }
  const raise = parsed.body.raise as { usd?: number; minutes?: number } | undefined;
  const needed = resume.raise;
  if (needed !== undefined && raise?.[needed] === undefined) {
    return error(400, `run ${runId} ran out of its ${needed === 'usd' ? 'dollars' : 'minutes'}: give raise.${needed}`);
  }
  const flags = [
    ...(raise?.usd === undefined ? [] : ['--raise-budget', String(raise.usd)]),
    ...(raise?.minutes === undefined ? [] : ['--raise-minutes', String(raise.minutes)]),
  ];
  if (underway.has(runId)) return error(409, `a start of ${runId} is already under way`);
  underway.add(runId);
  try {
    const log = join(runsDir(entry.sailDir), 'dashboard', `${runId}.log`);
    const spawned = spawnDetached(
      dirname(entry.sailDir),
      log,
      ['resume', runId, ...flags],
      environmentOf(options),
      options.cli,
    );
    const suspended = () => {
      try {
        return readStatus(dir).status !== 'suspended';
      } catch {
        return false;
      }
    };
    return await started(spawned, log, options.startWaitMs ?? 120_000, suspended, runAnswers(runId));
  } finally {
    underway.delete(runId);
  }
}

/**
 * Starts `sail run --from-run <run> --stage <stage> --continue --run-id <minted>` for a failed run, detached in its
 * clone, under an id minted here so the answer can name the new run. Answers 202 `{ runId }` once its `run.json` exists.
 */
async function restartRoute(starts: Starts, segments: string[], request: Request): Promise<Response> {
  const { options, underway } = starts;
  const found = runOf(options.registryDir, segments);
  if (found instanceof Response) return found;
  const { entry, runId, dir } = found;
  const parsed = await bodyOf(request, RestartBody, 'a restart');
  if (parsed instanceof Response) return parsed;
  const actions = await runActions(entry, runId, {
    leasesDir: options.leasesDir,
    env: options.env,
    ports: options.ports,
  });
  const { restart } = actions;
  if (restart === undefined || !restart.enabled) {
    return error(409, restart?.why ?? actions.why ?? `run ${runId} offers no restart`);
  }
  const { stage } = parsed.body;
  if (!restart.stages.some((each) => each.stage === stage)) {
    const known = restart.stages.map((each) => each.stage).join(', ');
    return error(400, `'${stage}' is no stage to restart ${runId} from: ${known}`);
  }
  const { source } = readRunHeader(dir);
  if (source.kind !== 'ticket') return error(409, `run ${runId} started from a pull request`);
  if (underway.has(runId)) return error(409, `a start of ${runId} is already under way`);
  underway.add(runId);
  try {
    const minted = newRunId(source.ticketKey);
    const runs = runsDir(entry.sailDir);
    const log = join(runs, 'dashboard', `${minted}.log`);
    const args = ['run', '--from-run', runId, '--stage', stage, '--continue', '--run-id', minted];
    const spawned = spawnDetached(dirname(entry.sailDir), log, args, environmentOf(options), options.cli);
    const opened = () => existsSync(join(runs, minted, RUN_HEADER_FILE));
    return await started(spawned, log, options.startWaitMs ?? 120_000, opened, runAnswers(minted));
  } finally {
    underway.delete(runId);
  }
}

/**
 * Changes a repository's watch set by running `sail watch <names>` or `sail unwatch <names>` in its clone, and passes
 * the CLI's own line and refusals through. With no live watcher a watch starts one, detached, its output in
 * `.sail-runs/dashboard/watcher.log`: 202 `{ message, pid }` once the registry records it live in this clone. Any other
 * change waits for the command to end, its output in `watch-set.log`: 200 `{ message, workflows }` with the set the
 * watcher watches now, 202 `{ waiting }` when the command is not taken yet or still runs, 409 with the CLI's last line
 * when it refuses or fails. The CLI makes every other check.
 */
async function watchSetRoute(starts: Starts, segments: string[], request: Request): Promise<Response> {
  const { options, underway } = starts;
  const [, , name = '', op = ''] = segments;
  const entry = findRepo(options.registryDir, name);
  if (entry === undefined) return error(404, `no repository '${name}'`);
  const parsed = await bodyOf(request, WatchBody, 'a watch-set change');
  if (parsed instanceof Response) return parsed;
  const { workflows } = parsed.body;
  const odd = workflows.find((each) => !isPlainName(each));
  if (odd !== undefined) return error(400, `'${odd}' is no workflow name`);
  if (!existsSync(entry.sailDir)) return error(409, `${entry.sailDir} no longer exists`);
  const key = `watch-set ${name}`;
  if (underway.has(key)) return error(409, `a watch-set change of '${name}' is already under way`);
  underway.add(key);
  try {
    const waitMs = options.startWaitMs ?? 120_000;
    const runs = runsDir(entry.sailDir);
    const before = liveWatcher(entry);
    const root = dirname(entry.sailDir);
    if (op === 'watch' && before === undefined) {
      const log = join(runs, 'dashboard', 'watcher.log');
      const spawned = spawnDetached(root, log, ['watch', ...workflows], environmentOf(options), options.cli);
      const here = () => {
        const current = findRepo(options.registryDir, name);
        const watcher = current === undefined ? undefined : liveWatcher(current);
        return watcher?.sailDir === entry.sailDir ? watcher : undefined;
      };
      return await started(spawned, log, waitMs, () => here() !== undefined, {
        held: () => {
          const pid = here()?.pid ?? 0;
          return {
            message: `the watcher of '${name}' (pid ${pid}) starts, its output in .sail-runs/dashboard/watcher.log`,
            pid,
          };
        },
        late: () => ({
          waiting: `the watcher of '${name}' is still starting: its output is in .sail-runs/dashboard/watcher.log`,
        }),
      });
    }
    const log = join(runs, 'dashboard', 'watch-set.log');
    const spawned = spawnDetached(root, log, [op, ...workflows], environmentOf(options), options.cli);
    const exit = await Promise.race([spawned.exited, sleep(waitMs).then(() => 'late' as const)]);
    if (exit === 'late') {
      return Response.json(
        {
          waiting: `the change of the watch set of '${name}' is still under way: its output is in .sail-runs/dashboard/watch-set.log`,
        },
        { status: 202 },
      );
    }
    const line = lastLine(log, spawned.logFrom);
    if (exit !== 0) return error(409, line ?? `sail ${op} exited ${exit ?? 'on a signal'}`);
    const message = line ?? `sail ${op} exited 0`;
    if (message.includes(NOT_TAKEN)) return Response.json({ waiting: message }, { status: 202 });
    const set = before === undefined ? [] : liveSet(entry.sailDir, before.pid).map((each) => each.workflow);
    return Response.json({ message, workflows: set });
  } finally {
    underway.delete(key);
  }
}

/** The repository and the clone's ports a stop or a clean works with, or the answer that refuses the request. */
async function clonesOf(options: DashboardOptions, segments: string[]) {
  const [, , name = ''] = segments;
  const entry = findRepo(options.registryDir, name);
  if (entry === undefined) return error(404, `no repository '${name}'`);
  const env = options.env ?? process.env;
  const ports = await (options.ports ?? ((each) => clonePorts(each, env)))(entry);
  if ('refused' in ports) return error(409, ports.refused);
  return { entry, ports, env };
}

/**
 * Stops a run as `sail stop` does: the engine's `stopRun()` in this process. A run still starting, which has no
 * run.json yet, is stopped through its hand-off file. Answers 202 `{ message }`, or 409 with the engine's refusal.
 */
async function stopRoute(starts: Starts, segments: string[], request: Request): Promise<Response> {
  const { options, underway } = starts;
  const [, , , , runId = ''] = segments;
  const parsed = await bodyOf(request, StopBody, 'a stop');
  if (parsed instanceof Response) return parsed;
  const found = await clonesOf(options, segments);
  if (found instanceof Response) return found;
  const { entry, ports, env } = found;
  const key = `stop ${runId}`;
  if (underway.has(key)) return error(409, `a stop of ${runId} is already under way`);
  underway.add(key);
  try {
    const runs = runsDir(entry.sailDir);
    const stopped = await stopRun({
      sailDir: entry.sailDir,
      runId,
      adapters: ports.adapters,
      now: parsed.body.now,
      secrets: credentialValues(env),
      starting: (id) => startingRun(runs, id),
    });
    if ('refused' in stopped) return error(409, stopped.refused);
    return Response.json({ message: stoppedMessage(runId, stopped) }, { status: 202 });
  } finally {
    underway.delete(key);
  }
}

/**
 * Cleans a failed run as `sail clean` does: the engine's `cleanRun()` in this process, which makes all its checks
 * before any removal. Answers 200 with the line `sail clean` prints, or 409 with the refusal or the failed removals.
 * Unlike `sail clean`, it resets no ticket and settles no queue item: a run a queue item names is refused.
 */
async function cleanRoute(starts: Starts, segments: string[], request: Request): Promise<Response> {
  const { options, underway } = starts;
  const [, , , , runId = ''] = segments;
  const parsed = await bodyOf(request, CleanBody, 'a clean');
  if (parsed instanceof Response) return parsed;
  const found = await clonesOf(options, segments);
  if (found instanceof Response) return found;
  const { entry, ports, env } = found;
  const key = `clean ${runId}`;
  if (underway.has(key)) return error(409, `a clean of ${runId} is already under way`);
  underway.add(key);
  try {
    const cleaned = await cleanRun({
      sailDir: entry.sailDir,
      runId,
      workspace: ports.adapters.ports.workspace,
      queueItems: (id) => queueItemsNaming(runsDir(entry.sailDir), id),
      codeHost: ports.codeHost,
      env,
    });
    if ('refused' in cleaned) return error(409, cleaned.refused);
    if ('failed' in cleaned) {
      const { failures } = cleaned.failed;
      return error(409, `${failures.join('; ')}; its run directory stays at .sail-runs/${runId}; clean it again`);
    }
    const { removed, archived } = cleaned.cleaned;
    const home = env.HOME ?? homedir();
    return Response.json({ message: cleanedMessage(runId, cleaned.cleaned, home), removed, archived });
  } finally {
    underway.delete(key);
  }
}

/** The environment a run the server starts gets: the server's own, with no variable left unset. */
function environmentOf(options: DashboardOptions): Record<string, string> {
  const env = options.env ?? process.env;
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** The refusal of a request the dashboard doesn't serve, or undefined to let it through. */
export function guard(request: Request, port: number): Response | undefined {
  const allowed = origins(port);
  if (!allowed.includes(request.headers.get('host') ?? ''))
    return error(403, 'this dashboard answers only its own host');
  const client = request.headers.get(CLIENT_HEADER) === '1';
  if (request.method !== 'GET') {
    const path = new URL(request.url).pathname;
    if (
      request.method !== 'POST' ||
      ![MOVE_PATH, QUEUE_OP_PATH, RESUME_PATH, RESTART_PATH, STOP_PATH, CLEAN_PATH, WATCH_PATH].some((each) =>
        each.test(path),
      )
    ) {
      return error(
        405,
        'the dashboard answers only GET, and POST to a queue change, a resume, a restart, a stop, a clean, a watch or an unwatch',
        {
          Allow: 'GET',
        },
      );
    }
    if (!client) return error(403, `send ${CLIENT_HEADER}: 1`);
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return error(415, 'send the body as application/json');
    }
    const origin = request.headers.get('origin');
    if (origin !== null && !allowed.some((host) => origin === `http://${host}`)) {
      return error(403, 'a POST needs this dashboard as its origin');
    }
    return undefined;
  }
  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const origin = request.headers.get('origin');
    const ok = origin === null ? client : allowed.some((host) => origin === `http://${host}`);
    return ok ? undefined : error(403, 'a WebSocket needs this dashboard as its origin');
  }
  if (new URL(request.url).pathname === '/') return undefined;
  return client ? undefined : error(403, `send ${CLIENT_HEADER}: 1`);
}

const STREAMS: Record<string, string> = { session: 'session.log', stdout: 'stdout.log', stderr: 'stderr.log' };

/**
 * A file served as `type`, once it is known to be a regular file inside `runDir`. The checked real path is what is
 * read, and it is streamed, so a symlink swapped in after the check isn't followed and a huge log isn't held whole.
 * An empty file is answered with an empty body: Bun 1.3.14 turns an empty `Bun.file` into a 204, whatever the status.
 */
function file(runDir: string, path: string, type: string): Response {
  const real = containedFile(runDir, path);
  if (real === undefined) return error(404, 'no such file in this run');
  const body = Bun.file(real);
  return new Response(body.size === 0 ? '' : body, { headers: { 'Content-Type': type } });
}

/** The answer to a GET of `/api/…`, from the path's decoded segments. */
async function route(options: DashboardOptions, segments: string[], url: URL): Promise<Response> {
  const { registryDir } = options;
  const [api, reposWord, name, kind, runId, part, key, what, ...rest] = segments;
  if (api !== 'api' || reposWord !== 'repos') return error(404, 'no such route');
  if (name === undefined) return Response.json(repos(registryDir));
  const entry = findRepo(registryDir, name);
  if (entry === undefined) return error(404, `no repository '${name}'`);
  if (kind === 'queues' && runId === undefined) return Response.json(queueViews(entry));
  if (kind !== 'runs') return error(404, 'no such route');
  if (runId === undefined) return Response.json(runItems(entry));
  const runDir = findRunDir(entry, runId);
  // A dispatched run still starting has no run directory yet, but its actions offer Stop.
  if (part === 'actions' && key === undefined) {
    if (typeof runDir !== 'string' && !startingRun(runsDir(entry.sailDir), runId)) return error(404, runDir.missing);
    return Response.json(
      await runActions(entry, runId, { leasesDir: options.leasesDir, env: options.env, ports: options.ports }),
    );
  }
  if (typeof runDir !== 'string') return error(404, runDir.missing);
  if (part === 'summary' && key === undefined) return file(runDir, join(runDir, 'summary.json'), 'application/json');
  if (part === 'events' && key === undefined) {
    return file(runDir, join(runDir, 'events.ndjson'), 'application/x-ndjson');
  }
  if (part === 'file' && key === undefined) return runFile(runDir, url);
  if (part !== 'calls' || key === undefined || rest.length > 0) return error(404, 'no such route');
  if (what === 'result') return served(runDir, callFile(runDir, key, 'result.json'), 'application/json');
  if (what !== 'log') return error(404, 'no such route');
  const stream = url.searchParams.get('stream');
  if (stream !== null && STREAMS[stream] === undefined) return error(400, '?stream takes session, stdout or stderr');
  if (stream !== null) return served(runDir, callFile(runDir, key, STREAMS[stream] ?? ''), 'text/plain; charset=utf-8');
  const session = callFile(runDir, key, 'session.log');
  const log = typeof session === 'string' ? session : callFile(runDir, key, 'stdout.log');
  return served(runDir, log, 'text/plain; charset=utf-8');
}

/**
 * The run's file at `?path=`, relative to the run directory, as text, or with `as=html` as the HTML of its markdown.
 * A path outside the run, or not a regular file, is 404.
 */
function runFile(runDir: string, url: URL): Response {
  const path = url.searchParams.get('path');
  if (path === null || path === '') return error(400, '?path names a file of the run');
  const as = url.searchParams.get('as');
  if (as !== null && as !== 'html') return error(400, '?as takes html');
  if (as === null) return file(runDir, join(runDir, path), 'text/plain; charset=utf-8');
  const real = containedFile(runDir, join(runDir, path));
  if (real === undefined) return error(404, 'no such file in this run');
  return new Response(renderMarkdown(readFileSync(real, 'utf8')), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function served(runDir: string, path: string | { missing: string }, type: string): Response {
  return typeof path === 'string' ? file(runDir, path, type) : error(404, path.missing);
}

/** The path's segments, each decoded after the split, so an encoded `/` stays inside its segment. */
function segmentsOf(url: URL): string[] | undefined {
  try {
    return url.pathname.split('/').slice(1).map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

type SocketData = { run: string } | { queue: string } | { index: true };

/** Starts the dashboard on 127.0.0.1. A port in use is refused. */
export function startDashboard(options: DashboardOptions): Dashboard | { refused: string } {
  const { registryDir } = options;
  const starts: Starts = { options, underway: new Set() };
  const feed = createIndexFeed(registryDir, options.indexPollMs ?? 1000);
  const page = createPage();
  const followPollMs = options.followPollMs ?? 200;
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const stops = new Map<ServerWebSocket<SocketData>, () => void>();
  let server: Server<SocketData>;
  try {
    server = Bun.serve<SocketData>({
      hostname: '127.0.0.1',
      port: options.port,
      // Without it, Bun answers a thrown error with its development page: HTML, with the stack and the source. Not
      // `development: false`, which lets a second server take the same port.
      error: (thrown) => error(500, `the dashboard could not read this: ${messageOf(thrown)}`),
      fetch(request, self) {
        const port = self.port ?? 0;
        const refused = guard(request, port);
        if (refused !== undefined) return refused;
        const url = new URL(request.url);
        if (url.pathname === '/') return page.response(request.headers.get('host') ?? '');
        if (url.pathname === '/ws') {
          const target = resolveTarget(url, registryDir);
          if ('status' in target) return error(target.status, target.error);
          const data: SocketData =
            'run' in target
              ? { run: target.run.runDir }
              : 'queue' in target
                ? { queue: target.queue.dir }
                : { index: true };
          if (self.upgrade(request, { data })) return undefined;
          return error(400, 'this request is not a WebSocket upgrade');
        }
        const segments = segmentsOf(url);
        if (segments === undefined) return error(400, 'the path is not percent-encoded properly');
        if (request.method === 'POST') {
          const path = url.pathname;
          // A start is waited for up to `startWaitMs`, past Bun's 10 s idle timeout, which would close the request.
          const start = RESUME_PATH.test(path)
            ? resumeRoute
            : RESTART_PATH.test(path)
              ? restartRoute
              : STOP_PATH.test(path)
                ? stopRoute
                : CLEAN_PATH.test(path)
                  ? cleanRoute
                  : undefined;
          if (start !== undefined) {
            self.timeout(request, 0);
            return start(starts, segments, request);
          }
          if (WATCH_PATH.test(path)) {
            self.timeout(request, 0);
            return watchSetRoute(starts, segments, request);
          }
          if (QUEUE_OP_PATH.test(path)) {
            self.timeout(request, 0);
            return queueOpRoute(options, segments, request);
          }
          return moveRoute(registryDir, segments, request);
        }
        return route(options, segments, url);
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          if ('run' in ws.data) stops.set(ws, openRunStream(ws, ws.data.run, followPollMs));
          else if ('queue' in ws.data) stops.set(ws, openQueueFollow(ws, ws.data.queue, followPollMs));
          else feed.add(ws);
        },
        close(ws) {
          sockets.delete(ws);
          stops.get(ws)?.();
          stops.delete(ws);
          feed.remove(ws);
        },
        message() {
          // The streams are one-way: anything a client sends is ignored.
        },
      },
    });
  } catch (thrown) {
    if ((thrown as { code?: string }).code === 'EADDRINUSE') {
      return { refused: `port ${options.port} is in use` };
    }
    throw thrown;
  }
  const port = server.port ?? options.port;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    async stop() {
      for (const stop of stops.values()) stop();
      stops.clear();
      feed.stop();
      for (const ws of sockets) ws.close(1001);
      sockets.clear();
      // A forced stop closes the listener and every connection before it returns. Its promise also waits for Bun's
      // count of open WebSockets, which Bun 1.3.14 never lowers for a socket closed from this side, so it can stay
      // pending for good. Raced against a settled promise, it is not waited on, and a rejection is still handled.
      await Promise.race([server.stop(true), Promise.resolve()]);
    },
  };
}
