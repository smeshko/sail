// Masks secrets wherever an adapter could hand them on: in a message, in a provider's `raw`, in an event (DECISIONS
// D11). Each secret is masked as written, URL-encoded and in base64, git's Basic credential `x-access-token:<secret>`
// included, so a token echoed back in any of those forms leaves as `[redacted]`.
//
// A stub until TASK-002: it masks nothing.

export const REDACTED = '[redacted]';

export interface Redactor {
  /** `text` with every form of every secret masked. */
  text(text: string): string;
  /** A deep copy of a JSON-like value, every string and object key masked. Anything else passes through. */
  value<T>(value: T): T;
  /** A PortError with the same port, op and code, its message and `raw` masked, or any other error's message masked. */
  error(error: unknown): Error;
}

export function redactor(_secrets: readonly string[]): Redactor {
  return {
    text: (text) => text,
    value: (value) => value,
    error: (error) => (error instanceof Error ? error : new Error(String(error))),
  };
}
