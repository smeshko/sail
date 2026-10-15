// Masks secrets wherever an adapter could hand them on: in a message, in a provider's `raw`, in an event (DECISIONS
// D11). Each secret is masked as written, URL-encoded and in base64, git's Basic credential `x-access-token:<secret>`
// included, so a token echoed back in any of those forms leaves as `[redacted]`.
import { PortError } from '../ports/errors';

export const REDACTED = '[redacted]';

export interface Redactor {
  /** `text` with every form of every secret masked. */
  text(text: string): string;
  /** A deep copy of a JSON-like value, every string and object key masked. Anything else passes through. */
  value<T>(value: T): T;
  /** A PortError with the same port, op and code, its message and `raw` masked, or any other error's message masked. */
  error(error: unknown): Error;
}

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** Each form a secret can take. Base64 is masked with its padding, then without, as it reads inside a longer encoding. */
function forms(secret: string): string[] {
  const encoded = [base64(secret), base64(`x-access-token:${secret}`)];
  return [secret, encodeURIComponent(secret), ...encoded, ...encoded.map((form) => form.replace(/=+$/, ''))];
}

export function redactor(secrets: readonly string[]): Redactor {
  // Longer forms first: a secret that contains another must not leave a fragment of itself behind.
  const masked = [...new Set(secrets.filter((secret) => secret !== '').flatMap(forms))]
    .filter((form) => form !== '')
    .sort((a, b) => b.length - a.length);
  const text = (input: string): string => masked.reduce((out, form) => out.split(form).join(REDACTED), input);
  const value = <T>(input: T): T => {
    if (typeof input === 'string') return text(input) as T;
    if (Array.isArray(input)) return input.map((each) => value(each)) as T;
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, each]) => [text(key), value(each)])) as T;
    }
    return input;
  };
  return {
    text,
    value,
    error(error) {
      if (error instanceof PortError) {
        const prefix = `${error.port}.${error.op}: `;
        const message = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
        return new PortError(error.port, error.op, error.code, text(message), value(error.raw));
      }
      return new Error(text(error instanceof Error ? error.message : String(error)));
    },
  };
}
