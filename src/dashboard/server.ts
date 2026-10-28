// The dashboard's server: the registry's run files and queues, read-only but for one request, on 127.0.0.1. Every
// request passes the guard first:
//
// 1. `Host` must be this server's (`127.0.0.1:<port>` or `localhost:<port>`), so a DNS-rebinding page gets 403.
// 2. Only GET: anything else is 405, OPTIONS included, so a cross-origin preflight fails. The one exception is a POST to
//    `/api/repos/<repo>/queues/<workflow>/move`, which needs the client header (403), `Content-Type: application/json`
//    (415) and an `Origin` that is absent or this server's own (403). It never writes a queue: it drops a move command
//    in the watcher's inbox, as `sail queue move` does, and answers 409 when no watcher is live.
// 3. A WebSocket upgrade needs a same-origin `Origin`, or no `Origin` and the client header: browsers can't set headers
//    on an upgrade, but always send `Origin`.
// 4. A GET of exactly `/` is the page, which a navigation fetches with no header of its own. It holds no data: all it
//    shows comes over `/api` and `/ws`, under the checks above and below.
// 5. Any other request needs `X-Sail-Dashboard: 1`, which a cross-origin page can't send without a preflight.
//
// No answer carries a CORS header. Errors are JSON, `{ "error": "…" }`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { z } from 'zod';
import { runsDir } from '../engine/run-dir';
import { dropCommand } from '../watch/inbox';
import { liveWatcher } from '../watch/registry';
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
 * Asks the repository's live watcher to move a queued item, by dropping a move command in its inbox: the watcher alone
 * writes the queue. Refused unless the item and its target are both queued, and a watcher is running.
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
  if (liveWatcher(entry) === undefined) {
    return error(409, `no watcher is running for '${entry.name}': sail watch ${workflow} first`);
  }
  const file = dropCommand(runsDir(entry.sailDir), {
    op: 'move',
    workflow,
    dedupKey,
    ...(before === undefined ? { after: target } : { before: target }),
  });
  return Response.json({ file }, { status: 202 });
}

/** The refusal of a request the dashboard doesn't serve, or undefined to let it through. */
export function guard(request: Request, port: number): Response | undefined {
  const allowed = origins(port);
  if (!allowed.includes(request.headers.get('host') ?? ''))
    return error(403, 'this dashboard answers only its own host');
  const client = request.headers.get(CLIENT_HEADER) === '1';
  if (request.method !== 'GET') {
    if (request.method !== 'POST' || !MOVE_PATH.test(new URL(request.url).pathname)) {
      return error(405, 'the dashboard answers only GET, and POST to a queue move', { Allow: 'GET' });
    }
    if (!client) return error(403, `send ${CLIENT_HEADER}: 1`);
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return error(415, 'send the move as application/json');
    }
    const origin = request.headers.get('origin');
    if (origin !== null && !allowed.some((host) => origin === `http://${host}`)) {
      return error(403, 'a move needs this dashboard as its origin');
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
function route(registryDir: string, segments: string[], url: URL): Response {
  const [api, reposWord, name, kind, runId, part, key, what, ...rest] = segments;
  if (api !== 'api' || reposWord !== 'repos') return error(404, 'no such route');
  if (name === undefined) return Response.json(repos(registryDir));
  const entry = findRepo(registryDir, name);
  if (entry === undefined) return error(404, `no repository '${name}'`);
  if (kind === 'queues' && runId === undefined) return Response.json(queueViews(entry));
  if (kind !== 'runs') return error(404, 'no such route');
  if (runId === undefined) return Response.json(runItems(entry));
  const runDir = findRunDir(entry, runId);
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
        if (request.method === 'POST') return moveRoute(registryDir, segments, request);
        return route(registryDir, segments, url);
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
