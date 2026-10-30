// Recording: a Harness that wraps another and writes every session it runs as a recording, one file per call key, masked
// of secrets and machine paths (11.3 D2 to D6). The fake harness plays a recording back (fake/playback.ts). The core
// never imports this module: the CLI, a composition root, wraps the harness it resolved.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { readJournal } from '../engine/journal';
import { redactor } from '../engine/redact';
import type { Harness, HarnessEvent, HarnessRequest } from '../ports/harness';
import { HarnessFailure, type HarnessResult, Usage } from '../ports/types';

/** A produced file: text that survives a UTF-8 round trip as `utf8`, anything else as `base64`. */
const RecordedFile = z.object({ encoding: z.enum(['utf8', 'base64']), content: z.string() });

const session = { sessionId: z.string(), usage: Usage, transcript: z.string() };

/** A `HarnessResult` without its `raw`: the provider's messages have a field of their own. */
const RecordedResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('done'), output: z.unknown(), ...session }),
  z.object({ outcome: z.literal('blocked'), reason: z.string(), ...session }),
  z.object({
    outcome: z.literal('error'),
    message: z.string(),
    reason: HarnessFailure.optional(),
    resetsAt: z.iso.datetime().optional(),
    ...session,
  }),
]);

const RecordedTry = z.object({
  try: z.number().int().min(1),
  request: z.object({
    model: z.string(),
    budget: z.object({ maxTurns: z.number(), maxUsd: z.number(), maxMinutes: z.number() }),
    promptSha256: z.string(),
  }),
  events: z.array(z.looseObject({ type: z.string() })),
  result: RecordedResult,
  files: z.record(z.string(), RecordedFile),
  raw: z.array(z.unknown()),
});
export type RecordedTry = z.infer<typeof RecordedTry>;

/** The file of one call key: its tries, in order. Test data that only the fake harness reads, so it has no JSON Schema. */
export const Recording = z.object({
  recording: z.literal(1),
  key: z.string().min(1),
  tries: z.array(RecordedTry).min(1),
});
export type Recording = z.infer<typeof Recording>;

/** `<dir>/<key>.json`, the key's `/` written `+`: a file name can't hold it. */
export const recordingFile = (dir: string, key: string): string => join(dir, `${key.replaceAll('/', '+')}.json`);

/** The paths a request names, by the word that stands for each in a recording. */
export function requestRoots(request: HarnessRequest): Record<string, string> {
  const roots: Record<string, string> = { $WORKSPACE: request.cwd };
  if (request.env.STAGE_IN !== undefined) roots.$STAGE_IN = request.env.STAGE_IN;
  if (request.env.STAGE_OUT !== undefined) roots.$STAGE_OUT = request.env.STAGE_OUT;
  return roots;
}

/** A path without its trailing slashes, or `undefined` when nothing but the filesystem root is left. */
function trimmed(path: string): string | undefined {
  const bare = path.replace(/\/+$/, '');
  return bare === '' ? undefined : bare;
}

/**
 * The forms a path takes in what a session sees: as written, URL-encoded (a `file://` URL, a query), and with every
 * character but a letter or a digit turned into `-`, as Claude Code names a project's folder after its cwd. The dashed
 * form is left out for a path of one segment, such as `/tmp`, which would match ordinary words.
 */
function pathForms(path: string): string[] {
  const dashed = path.split('/').filter((part) => part !== '').length >= 2 ? [path.replace(/[^A-Za-z0-9]/g, '-')] : [];
  return [path, encodeURI(path), encodeURIComponent(path), ...dashed];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An absolute path that starts a token: after the start, a character no path holds, or a JSON text's `\n`, `\r` or `\t`.
 * Never inside a relative path, a URL or a path a word already stands for (`$STAGE_IN/tickets`).
 */
const ABSOLUTE = /(?<=^|[^A-Za-z0-9._~$@%+/\\-]|\\[nrt])(?:\/[A-Za-z0-9._@+~-]+)+/g;

/** The top-level directories every Unix has, whose paths name no machine: `/dev/null`, `/usr/bin/env`, `/etc/hosts`. */
const PORTABLE = new Set(['bin', 'dev', 'etc', 'lib', 'lib32', 'lib64', 'proc', 'sbin', 'sys', 'usr']);

/** The names in this machine's filesystem root, or none when it can't be listed. */
function topLevelDirectories(): string[] {
  try {
    return readdirSync('/');
  } catch {
    return [];
  }
}

/**
 * An absolute path outside every root, as a recording holds it. A system temp path, `/tmp` or macOS's per-user
 * `/var/folders/<a>/<b>`, each also under `/private`, is `$TMP` and its last segment. A path of two segments or more
 * under another of the machine's top-level directories (`/Applications`, `/opt`, `/home`) is `$MACHINE` and its last
 * segment. Anything else is left as written: a portable path, or one whose first segment the machine doesn't have, which
 * is the fixture's own text, not a place on the machine.
 */
function machinePath(path: string, top: ReadonlySet<string>): string {
  const parts = path.split('/').slice(1);
  const local = parts[0] === 'private' ? parts.slice(1) : parts;
  const last = parts[parts.length - 1];
  if (local[0] === 'tmp') return local.length === 1 ? '$TMP' : `$TMP/${last}`;
  if (local[0] === 'var' && local[1] === 'folders') return local.length <= 4 ? '$TMP' : `$TMP/${last}`;
  const [first = ''] = parts;
  return parts.length >= 2 && top.has(first) && !PORTABLE.has(first) ? `$MACHINE/${last}` : path;
}

/**
 * A function that replaces each root with its word in every string of a value: longest first, realpath forms too, each
 * also URL-encoded and dashed (`pathForms()`). Each of `names`, such as the user's login, is then replaced in any case
 * where a path or a listing carries it and no root did: a path segment (`/Users/<login>/`), a dashed one
 * (`-Users-<login>-`), and the owner and group columns of `ls -l` (`1 <login> <login>`). Only there: a login can be a
 * word the recording itself uses, such as `agent`, `model` or `user`, in an event's type or a request's field. Last, an
 * absolute path still left keeps only its last segment when it is a temp path or a place on this machine
 * (`machinePath()`), `top` being the names in the machine's filesystem root.
 */
export function maskPaths(
  roots: Readonly<Record<string, string>>,
  names: Readonly<Record<string, string>> = {},
  top: readonly string[] = topLevelDirectories(),
): <T>(value: T) => T {
  const machine = new Set(top);
  const pairs: [string, string][] = [];
  for (const [word, path] of Object.entries(roots)) {
    const bare = trimmed(path);
    if (bare === undefined) continue;
    const paths = [bare];
    try {
      const real = trimmed(realpathSync(bare));
      if (real !== undefined && real !== bare) paths.push(real);
    } catch {
      // A root that doesn't exist has no other form.
    }
    for (const form of new Set(paths.flatMap(pathForms))) pairs.push([form, word]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  const words = Object.entries(names)
    .filter(([, name]) => name.length >= 3)
    .map(([word, name]) => {
      const login = escapeRegExp(name);
      return [new RegExp(`(?<=[/-]|\\d\\s+|${login}\\s+)${login}(?![A-Za-z0-9_])`, 'gi'), word] as const;
    });
  const text = (input: string): string =>
    words
      .reduce(
        (out, [name, word]) => out.replace(name, word),
        pairs.reduce((out, [path, word]) => out.split(path).join(word), input),
      )
      .replace(ABSOLUTE, (path) => machinePath(path, machine));
  const value = <T>(input: T): T => {
    if (typeof input === 'string') return text(input) as T;
    if (Array.isArray(input)) return input.map((each) => value(each)) as T;
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, each]) => [text(key), value(each)])) as T;
    }
    return input;
  };
  return value;
}

/** The hex sha256 of the prompt with the request's own paths masked, so it is the same on every machine. */
export const promptSha256 = (request: HarnessRequest): string =>
  createHash('sha256')
    .update(maskPaths(requestRoots(request))(request.prompt))
    .digest('hex');

/** Each file under `out` that isn't under `skip`, by its path relative to `out` → the sha256 of its bytes. */
function snapshot(out: string | undefined, skip: string | undefined): Map<string, string> {
  const seen = new Map<string, string>();
  if (out === undefined || !existsSync(out)) return seen;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (skip !== undefined && (path === skip || path.startsWith(skip + sep))) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const name = relative(out, path).split(sep).join('/');
        seen.set(name, createHash('sha256').update(readFileSync(path)).digest('hex'));
      }
    }
  };
  walk(out);
  // In name order: a directory lists its entries in an order of its own, which differs between macOS and Linux, and a
  // recording must be the same file wherever it was made.
  return new Map([...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The bytes of each file that is new or changed since `before`, read from `out`, by name. */
function changedFiles(out: string | undefined, before: Map<string, string>, skip: string | undefined) {
  const files: [string, Buffer][] = [];
  if (out === undefined) return files;
  for (const [name, sha] of snapshot(out, skip)) {
    if (before.get(name) !== sha) files.push([name, readFileSync(join(out, name))]);
  }
  return files;
}

/** The text of `text`'s UTF-8 bytes, one character per byte: how a secret or a path reads inside a binary file. */
const asBytes = (text: string): string => Buffer.from(text, 'utf8').toString('latin1');

/**
 * A recorded file, masked. Text that survives a UTF-8 round trip is masked as text. Anything else is masked byte by byte
 * before it is base64-encoded: a secret or a path inside the encoding would no longer read as itself.
 */
function recordedFile(
  bytes: Buffer,
  text: (input: string) => string,
  binary: (input: string) => string,
): z.infer<typeof RecordedFile> {
  const decoded = bytes.toString('utf8');
  if (Buffer.from(decoded, 'utf8').equals(bytes)) return { encoding: 'utf8', content: text(decoded) };
  return { encoding: 'base64', content: Buffer.from(binary(bytes.toString('latin1')), 'latin1').toString('base64') };
}

export interface RecordingOptions {
  /** Where the recordings go. Made when it is missing. */
  readonly dir: string;
  /** Values masked in every form wherever they appear. A value under 8 characters would mask common words: leave it out. */
  readonly secrets: readonly string[];
  /** Paths masked beside the request's own, by the word that replaces each: `$RUNS`, `$REPO`, `$HOME`, `$TMPDIR`. */
  readonly roots: Readonly<Record<string, string>>;
  /** Names masked as whole words, by the word that replaces each: the user's login as `$USER`. */
  readonly names?: Readonly<Record<string, string>>;
}

/**
 * Each secret with the forms of it that `redactor()` doesn't know, for a recording that may hold any text a session saw:
 * - JSON-escaped with `/` escaped too, as some JSON writers emit it;
 * - base64 at offset 0 inside a longer encoding: the characters that depend only on the secret's own bytes, so a byte
 *   after it can't hide it. `redactor()` masks the cores behind a one- and two-byte lead itself.
 */
export function secretForms(secrets: readonly string[]): string[] {
  const forms: string[] = [];
  for (const secret of secrets) {
    forms.push(secret, JSON.stringify(secret).slice(1, -1).replaceAll('/', '\\/'));
    const bytes = Buffer.from(secret, 'utf8');
    const core = bytes.toString('base64').slice(0, Math.floor(bytes.length / 3) * 4);
    if (core.length >= 8) forms.push(core);
  }
  return [...new Set(forms)];
}

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Writes `file` through a temp file and a rename, so a reader never sees half a recording. */
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
}

/** `recorded` set as its try in the file of `key`, the file's other tries kept. */
function updated(file: string, key: string, recorded: RecordedTry): Recording {
  const existing = existsSync(file) ? Recording.parse(JSON.parse(readFileSync(file, 'utf8'))) : undefined;
  if (existing !== undefined && existing.key !== key) throw new Error(`${file} holds ${existing.key}, not ${key}`);
  const others = (existing?.tries ?? []).filter((each) => each.try !== recorded.try);
  return { recording: 1, key, tries: [...others, recorded].sort((a, b) => a.try - b.try) };
}

/** Runs every session on `inner` unchanged, and writes each try into its call key's recording. It never rejects. */
export function recordingHarness(inner: Harness, options: RecordingOptions): Harness {
  const secrets = redactor(secretForms(options.secrets));
  return {
    name: inner.name,
    capabilities: () => inner.capabilities(),
    async run(request) {
      const { STAGE_IN: stageIn, STAGE_OUT: out } = request.env;
      const events: HarnessEvent[] = [];
      const raw: unknown[] = [];
      let before: Map<string, string>;
      let result: HarnessResult;
      try {
        // Inside the try: a file in $STAGE_OUT that can't be read is the recording's failure, and never a rejection.
        before = snapshot(out, stageIn);
        result = await inner.run({
          ...request,
          onEvent: (event) => {
            events.push(event);
            request.onEvent?.(event);
          },
          onRaw: (message) => {
            raw.push(message);
            request.onRaw?.(message);
          },
        });
      } catch (error) {
        const message = `recording: ${failure(error)}`;
        return {
          outcome: 'error',
          message,
          reason: 'harness',
          sessionId: '',
          usage: { costUsd: 0 },
          transcript: '',
          raw: null,
        };
      }
      try {
        const { raw: _raw, ...kept } = result;
        const roots = { ...options.roots, ...requestRoots(request) };
        const names = options.names ?? {};
        const mask = maskPaths(roots, names);
        // Secrets first: a secret that holds a root would be split by the path's word, and leave the rest of itself.
        const scrub = <T>(value: T): T => mask(secrets.value(value));
        const maskBytes = maskPaths(
          Object.fromEntries(Object.entries(roots).map(([word, path]) => [word, asBytes(path)])),
          names,
        );
        const secretBytes = redactor(secretForms(options.secrets.map(asBytes)));
        const scrubBytes = (input: string): string => maskBytes(secretBytes.text(input));
        const files = changedFiles(out, before, stageIn).map(
          ([name, bytes]) => [scrub(name), recordedFile(bytes, scrub, scrubBytes)] as const,
        );
        const recorded = RecordedTry.parse({
          ...scrub({
            try: request.try,
            request: { model: request.model, budget: request.budget, promptSha256: promptSha256(request) },
            events,
            result: kept,
            raw,
          }),
          files: Object.fromEntries(files),
        });
        const file = recordingFile(options.dir, request.key);
        writeAtomic(file, `${JSON.stringify(updated(file, request.key, recorded), null, 2)}\n`);
        return result;
      } catch (error) {
        const { sessionId, usage, transcript } = result;
        return {
          outcome: 'error',
          message: `recording: ${failure(error)}`,
          reason: 'harness',
          sessionId,
          usage,
          transcript,
          raw: result.raw,
        };
      }
    },
  };
}

/** Writes `<dir>/journal.txt`: one `<key> <outcome>` line per line of the run's journal. */
export function writeJournalKeys(dir: string, runDir: string): void {
  const lines = readJournal(runDir).entries.map((entry) => `${entry.key} ${entry.outcome}\n`);
  writeAtomic(join(dir, 'journal.txt'), lines.join(''));
}
