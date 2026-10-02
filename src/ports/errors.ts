// How a port reports a failure its caller can't handle: a PortError naming the port, the operation and a code to
// branch on, such as the watcher pausing a workflow's polling on `unauthorized`. An operation that simply didn't
// happen, such as a claim not taken or a merge still pending, is a value instead (D5).
import type { Port } from '../engine/config';

export const PORT_ERROR_CODES = [
  'not_found',
  'unauthorized',
  'forbidden',
  'conflict',
  'invalid',
  'unavailable',
] as const;
export type PortErrorCode = (typeof PORT_ERROR_CODES)[number];

export class PortError extends Error {
  readonly port: Port;
  readonly op: string;
  readonly code: PortErrorCode;
  /** The provider's own answer, when there was one. */
  readonly raw?: unknown;

  // Written out, not implicit: Bun reads an implicit subclass constructor as uncovered.
  constructor(port: Port, op: string, code: PortErrorCode, message: string, raw?: unknown) {
    super(`${port}.${op}: ${message}`);
    this.name = 'PortError';
    this.port = port;
    this.op = op;
    this.code = code;
    if (raw !== undefined) this.raw = raw;
  }
}
