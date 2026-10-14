// The dashboard's server: the registry's run files, read-only, on 127.0.0.1. Every request passes the guard first:
//
// 1. `Host` must be this server's (`127.0.0.1:<port>` or `localhost:<port>`), so a DNS-rebinding page gets 403.
// 2. Only GET: anything else is 405, OPTIONS included, so a cross-origin preflight fails.
// 3. A WebSocket upgrade needs a same-origin `Origin`, or no `Origin` and the client header: browsers can't set headers
//    on an upgrade, but always send `Origin`.
// 4. Any other request needs `X-Sail-Dashboard: 1`, which a cross-origin page can't send without a preflight.
//
// No answer carries a CORS header. Errors are JSON, `{ "error": "…" }`.
import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { callFile, containedFile, findRepo, findRunDir, repos, runItems } from './files';
import { createIndexFeed, openRunStream, resolveTarget } from './streams';

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

/** The refusal of a request the dashboard doesn't serve, or undefined to let it through. */
export function guard(request: Request, port: number): Response | undefined {
  const allowed = origins(port);
  if (!allowed.includes(request.headers.get('host') ?? ''))
    return error(403, 'this dashboard answers only its own host');
  if (request.method !== 'GET') return error(405, 'the dashboard is read-only', { Allow: 'GET' });
  const client = request.headers.get(CLIENT_HEADER) === '1';
  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const origin = request.headers.get('origin');
    const ok = origin === null ? client : allowed.some((host) => origin === `http://${host}`);
    return ok ? undefined : error(403, 'a WebSocket needs this dashboard as its origin');
  }
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
  if (kind === 'queues' && runId === undefined) return Response.json([]);
  if (kind !== 'runs') return error(404, 'no such route');
  if (runId === undefined) return Response.json(runItems(entry));
  const runDir = findRunDir(entry, runId);
  if (typeof runDir !== 'string') return error(404, runDir.missing);
  if (part === 'summary' && key === undefined) return file(runDir, join(runDir, 'summary.json'), 'application/json');
  if (part === 'events' && key === undefined) {
    return file(runDir, join(runDir, 'events.ndjson'), 'application/x-ndjson');
  }
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

type SocketData = { run: string } | { index: true };

/** Starts the dashboard on 127.0.0.1. A port in use is refused. */
export function startDashboard(options: DashboardOptions): Dashboard | { refused: string } {
  const { registryDir } = options;
  const feed = createIndexFeed(registryDir, options.indexPollMs ?? 1000);
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
        if (url.pathname === '/ws') {
          const target = resolveTarget(url, registryDir);
          if ('status' in target) return error(target.status, target.error);
          const data: SocketData = 'run' in target ? { run: target.run.runDir } : { index: true };
          if (self.upgrade(request, { data })) return undefined;
          return error(400, 'this request is not a WebSocket upgrade');
        }
        const segments = segmentsOf(url);
        if (segments === undefined) return error(400, 'the path is not percent-encoded properly');
        return route(registryDir, segments, url);
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          if ('run' in ws.data) stops.set(ws, openRunStream(ws, ws.data.run, followPollMs));
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
