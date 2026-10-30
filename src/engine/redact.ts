// Masks secrets wherever an adapter could hand them on: in a message, in a provider's `raw`, in an event (DECISIONS
// D11). Each secret is masked as written, URL-encoded and in base64, git's Basic credential `x-access-token:<secret>`
// included, along with base64 cores behind one- and two-byte prefixes, so echoes leave as `[redacted]`.
import { closeSync, fstatSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { PortError } from '../ports/errors';

/**
 * Replaces a completed log atomically when it held a secret, retaining only a bounded window in memory. It works on
 * bytes, so invalid UTF-8 and a character split between chunks pass through as they were, and keeps the log's mode.
 */
export function redactFile(path: string, redact: Redactor): void {
  if (redact.maxLength === 0) return;
  let input: number;
  try {
    input = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const temporary = `${path}.${process.pid}.redacting`;
  let output: number | undefined;
  try {
    output = openSync(temporary, 'wx', fstatSync(input).mode & 0o777);
    const buffer = Buffer.alloc(64 * 1024);
    const keep = Math.max(redact.maxLength - 1, REDACTED.length);
    let carry = Buffer.alloc(0);
    let changed = false;
    while (true) {
      const size = readSync(input, buffer);
      if (size === 0) break;
      const read = Buffer.concat([carry, buffer.subarray(0, size)]);
      const masked = redact.bytes(read);
      if (masked !== read) changed = true;
      const cut = Math.max(0, masked.length - keep);
      writeSync(output, masked.subarray(0, cut));
      carry = Buffer.from(masked.subarray(cut));
    }
    const last = redact.bytes(carry);
    if (last !== carry) changed = true;
    writeSync(output, last);
    closeSync(output);
    output = undefined;
    if (changed) renameSync(temporary, path);
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
    rmSync(temporary, { force: true });
  }
}

const SECRET_NAME = /TOKEN|KEY|SECRET|PASS|AUTH|CREDENTIAL|COOKIE|SESSION|PRIVATE|HEADER|(^|_)PAT$/i;
const USERINFO = /[a-z][a-z0-9+.-]*:\/\/([^\s/:@]+):([^\s/@]+)@/gi;

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Credential-named values and their parts, plus URL userinfo, each at least eight characters. */
export function credentialValues(env: Readonly<Record<string, string | undefined>>): string[] {
  const found = new Set<string>();
  const add = (secret: string) => {
    if (secret.length >= 8) found.add(secret);
  };
  for (const [name, value = ''] of Object.entries(env)) {
    if (SECRET_NAME.test(name)) {
      add(value);
      for (const part of value.split(/[\s,;]+/)) if (!part.endsWith(':')) add(part);
    }
    for (const [, user = '', password = ''] of value.matchAll(USERINFO)) {
      for (const secret of [
        `${user}:${password}`,
        password,
        `${decoded(user)}:${decoded(password)}`,
        decoded(password),
      ]) {
        add(secret);
      }
    }
  }
  return [...found];
}

export const REDACTED = '[redacted]';

export interface Redactor {
  /** The longest form in UTF-8 bytes, or 0 when there is none. */
  readonly maxLength: number;
  /** `text` with every form of every secret masked. */
  text(text: string): string;
  /** `input` with every form of every secret's UTF-8 bytes masked: `input` itself when nothing matched. */
  bytes(input: Buffer): Buffer;
  /** A deep copy of a JSON-like value, every string and object key masked. Anything else passes through. */
  value<T>(value: T): T;
  /** A PortError with the same port, op and code, its message and `raw` masked, or any other error's message masked. */
  error(error: unknown): Error;
}

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** Each form a secret can take. Base64 is masked with its padding, then without, as it reads inside a longer encoding. */
function forms(secret: string): string[] {
  const encoded = [base64(secret), base64(`x-access-token:${secret}`)];
  const bytes = Buffer.from(secret);
  const cores = [1, 2]
    .map((lead) =>
      Buffer.concat([Buffer.alloc(lead), bytes])
        .toString('base64')
        .slice(4, Math.floor((lead + bytes.length) / 3) * 4),
    )
    .filter((core) => core.length >= 8);
  return [secret, encodeURIComponent(secret), ...encoded, ...encoded.map((form) => form.replace(/=+$/, '')), ...cores];
}

export function redactor(secrets: readonly string[]): Redactor {
  // Longer forms first: a secret that contains another must not leave a fragment of itself behind.
  const masked = [...new Set(secrets.filter((secret) => secret !== '').flatMap(forms))]
    .filter((form) => form !== '')
    .sort((a, b) => b.length - a.length);
  const text = (input: string): string => masked.reduce((out, form) => out.split(form).join(REDACTED), input);
  const encoded = masked.map((form) => Buffer.from(form)).sort((a, b) => b.length - a.length);
  const replacement = Buffer.from(REDACTED);
  const bytes = (input: Buffer): Buffer =>
    encoded.reduce((out, form) => {
      let at = out.indexOf(form);
      if (at === -1) return out;
      const parts: Buffer[] = [];
      let from = 0;
      while (at !== -1) {
        parts.push(out.subarray(from, at), replacement);
        from = at + form.length;
        at = out.indexOf(form, from);
      }
      parts.push(out.subarray(from));
      return Buffer.concat(parts);
    }, input);
  const value = <T>(input: T): T => {
    if (typeof input === 'string') return text(input) as T;
    if (Array.isArray(input)) return input.map((each) => value(each)) as T;
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, each]) => [text(key), value(each)])) as T;
    }
    return input;
  };
  return {
    maxLength: encoded[0]?.length ?? 0,
    text,
    bytes,
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
