// The dashboard's WebSockets, at `/ws`: `?run=<repo>/<id>` replays a run's events and follows it until it ends, and
// `?index=1` sends every repository's runs, then again whenever they change. `?queue=` is reserved for the watcher's
// queues (Epic 13). A target that can't be resolved is refused over HTTP, before any upgrade.
//
// Every message is one JSON object: `{ kind: 'event', event }`, `{ kind: 'end' }` before a close with 1000,
// `{ kind: 'error', message }` before a close with 1011, or `{ kind: 'index', repos }`.
import { followEvents } from '../events/follow';
import type { SailEvent } from '../events/types';
import { findRepo, findRunDir, type IndexRepo, index } from './files';

/** What a socket is opened on: one run's events, or the index. */
export type Target = { run: { runDir: string } } | { index: true };

/** The part of a socket the streams use. */
export interface Socket {
  send(text: string): unknown;
  close(code?: number, reason?: string): void;
}

export type Message =
  | { kind: 'event'; event: SailEvent }
  | { kind: 'end' }
  | { kind: 'error'; message: string }
  | { kind: 'index'; repos: IndexRepo[] };

export function sendMessage(socket: Socket, message: Message): void {
  socket.send(JSON.stringify(message));
}

const TARGETS = ['run', 'index', 'queue'];

/** The target `url`'s query names, or the HTTP status and error that refuse it. */
export function resolveTarget(url: URL, registryDir: string): Target | { status: number; error: string } {
  const given = TARGETS.filter((name) => url.searchParams.has(name));
  if (given.length !== 1) return { status: 400, error: 'name exactly one of ?run=<repo>/<run>, ?index=1, ?queue=' };
  if (given[0] === 'queue') return { status: 404, error: 'queues arrive with the watcher (Epic 13)' };
  if (given[0] === 'index') {
    return url.searchParams.get('index') === '1' ? { index: true } : { status: 400, error: '?index takes 1' };
  }
  const value = url.searchParams.get('run') ?? '';
  const slash = value.indexOf('/');
  const entry = slash < 1 ? undefined : findRepo(registryDir, value.slice(0, slash));
  if (entry === undefined) return { status: 404, error: `no repository for '${value}'` };
  const runDir = findRunDir(entry, value.slice(slash + 1));
  return typeof runDir === 'string' ? { run: { runDir } } : { status: 404, error: runDir.missing };
}

/** Replays the run's events to `socket` and follows them until the run ends. Returns what stops the follow. */
export function openRunStream(socket: Socket, runDir: string, pollMs: number): () => void {
  const controller = new AbortController();
  const failed = (message: string) => {
    sendMessage(socket, { kind: 'error', message });
    socket.close(1011);
  };
  followEvents(runDir, {
    onEvent: (event) => sendMessage(socket, { kind: 'event', event }),
    signal: controller.signal,
    pollMs,
  }).then(
    (result) => {
      if (result === 'aborted') return;
      if (result === 'ended') {
        sendMessage(socket, { kind: 'end' });
        socket.close(1000);
        return;
      }
      failed(result.refused);
    },
    (error: unknown) => failed(error instanceof Error ? error.message : String(error)),
  );
  return () => controller.abort();
}

/** The index stream: one poller shared by every index socket, running only while one is open. */
export interface IndexFeed {
  add(socket: Socket): void;
  remove(socket: Socket): void;
  stop(): void;
}

export function createIndexFeed(registryDir: string, pollMs: number): IndexFeed {
  const sockets = new Set<Socket>();
  let last = '';
  let timer: ReturnType<typeof setInterval> | undefined;
  const current = () => JSON.stringify({ kind: 'index', repos: index(registryDir) } satisfies Message);
  const tick = () => {
    const text = current();
    if (text === last) return;
    last = text;
    for (const socket of sockets) socket.send(text);
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  return {
    add(socket) {
      const text = current();
      socket.send(text);
      sockets.add(socket);
      if (text !== last) {
        last = text;
        for (const other of sockets) if (other !== socket) other.send(text);
      }
      timer ??= setInterval(tick, pollMs);
    },
    remove(socket) {
      sockets.delete(socket);
      if (sockets.size === 0) stop();
    },
    stop() {
      sockets.clear();
      stop();
    },
  };
}
