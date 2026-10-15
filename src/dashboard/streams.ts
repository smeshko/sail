// The dashboard's WebSockets, at `/ws`: `?run=<repo>/<id>` replays a run's events and follows it until it ends, and
// `?index=1` sends every repository's runs, then again whenever they change. `?queue=` is reserved for the watcher's
// queues (Epic 13). A target that can't be resolved is refused over HTTP, before any upgrade.
//
// Every message is one JSON object: `{ kind: 'event', event }`, `{ kind: 'end' }` before a close with 1000,
// `{ kind: 'error', message }` before a close with 1011, or `{ kind: 'index', repos }`.
import { followEvents } from '../events/follow';
import type { QueueEvent, SailEvent } from '../events/types';
import { findRepo, findRunDir, followProblem, type IndexRepo, index } from './files';

/** What a socket is opened on: one run's events, or the index. */
export type Target = { run: { runDir: string } } | { queue: { dir: string } } | { index: true };

/** The part of a socket the streams use. */
export interface Socket {
  /** Bun's answer: the bytes sent, -1 when queued behind backpressure, or 0 when the message was dropped. */
  send(text: string): number;
  close(code?: number, reason?: string): void;
}

export type Message =
  | { kind: 'event'; event: SailEvent }
  | { kind: 'queue-event'; event: QueueEvent }
  | { kind: 'end' }
  | { kind: 'error'; message: string }
  | { kind: 'index'; repos: IndexRepo[] };

/** Sends `message`. False when the socket dropped it. */
export function sendMessage(socket: Socket, message: Message): boolean {
  return socket.send(JSON.stringify(message)) !== 0;
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
  if (typeof runDir !== 'string') return { status: 404, error: runDir.missing };
  const unread = followProblem(runDir);
  return unread === undefined ? { run: { runDir } } : { status: 404, error: unread };
}

/**
 * Replays the run's events to `socket` and follows them until the run ends. Returns what stops the follow. An event the
 * socket drops ends the stream with 1011 and no `end`, so a client never takes a replay with a gap for a whole one.
 */
export function openRunStream(socket: Socket, runDir: string, pollMs: number): () => void {
  const controller = new AbortController();
  let dropped = false;
  const failed = (message: string) => {
    sendMessage(socket, { kind: 'error', message });
    socket.close(1011);
  };
  const onEvent = (event: SailEvent) => {
    if (dropped || sendMessage(socket, { kind: 'event', event })) return;
    dropped = true;
    controller.abort();
  };
  followEvents(runDir, {
    onEvent,
    signal: controller.signal,
    pollMs,
    check: () => followProblem(runDir),
  }).then(
    (result) => {
      if (dropped) return socket.close(1011, 'a message was dropped');
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

/**
 * Replays a queue's events to `socket` and follows them until the returned function stops it: a queue never ends, so
 * no `end` is ever sent. Its events have no `runId`, and go out as `queue-event`s.
 *
 * Stub (TASK-003): sends nothing.
 */
export function openQueueFollow(_socket: Socket, _dir: string, _pollMs: number): () => void {
  return () => undefined;
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
  /** The index message, or undefined while the registry can't be read: the next poll tries again. */
  const current = () => {
    try {
      return JSON.stringify({ kind: 'index', repos: index(registryDir) } satisfies Message);
    } catch {
      return undefined;
    }
  };
  /** Sockets that joined while the registry couldn't be read, and have had no index yet. */
  const waiting = new Set<Socket>();
  const tick = () => {
    const text = current();
    if (text === undefined) return;
    const changed = text !== last;
    last = text;
    for (const socket of changed ? sockets : waiting) socket.send(text);
    waiting.clear();
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  return {
    add(socket) {
      const text = current();
      sockets.add(socket);
      timer ??= setInterval(tick, pollMs);
      if (text === undefined) {
        waiting.add(socket);
        return;
      }
      socket.send(text);
      if (text !== last) {
        last = text;
        for (const other of sockets) if (other !== socket) other.send(text);
      }
    },
    remove(socket) {
      sockets.delete(socket);
      waiting.delete(socket);
      if (sockets.size === 0) stop();
    },
    stop() {
      sockets.clear();
      waiting.clear();
      stop();
    },
  };
}
