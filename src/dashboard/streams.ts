// The dashboard's WebSockets. A stub: the signatures are final, and it refuses every target and sends nothing until
// ADW-120's fifth task.
import type { SailEvent } from '../events/types';
import type { IndexRepo } from './files';

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

export function sendMessage(_socket: Socket, _message: Message): void {}

export function resolveTarget(_url: URL, _registryDir: string): Target | { status: number; error: string } {
  return { status: 404, error: '' };
}

export function openRunStream(_socket: Socket, _runDir: string, _pollMs: number): () => void {
  return () => {};
}

/** The index stream: one poller shared by every index socket, running only while one is open. */
export interface IndexFeed {
  add(socket: Socket): void;
  remove(socket: Socket): void;
  stop(): void;
}

export function createIndexFeed(_registryDir: string, _pollMs: number): IndexFeed {
  return { add() {}, remove() {}, stop() {} };
}
