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
  z.object({ outcome: z.literal('error'), message: z.string(), reason: HarnessFailure.optional(), ...session }),
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

/** A function that replaces each root with its word in every string of a value: longest first, realpath forms too. */
export function maskPaths(roots: Readonly<Record<string, string>>): <T>(value: T) => T {
  const pairs: [string, string][] = [];
  for (const [word, path] of Object.entries(roots)) {
    const bare = trimmed(path);
    if (bare === undefined) continue;
    pairs.push([bare, word]);
    try {
      const real = trimmed(realpathSync(bare));
      if (real !== undefined && real !== bare) pairs.push([real, word]);
    } catch {
      // A root that doesn't exist has no other form.
    }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  const text = (input: string): string => pairs.reduce((out, [path, word]) => out.split(path).join(word), input);
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
  return seen;
}

/** The files that are new or changed since `before`, read from `out`. */
function changedFiles(out: string | undefined, before: Map<string, string>, skip: string | undefined) {
  const files: Record<string, z.infer<typeof RecordedFile>> = {};
  if (out === undefined) return files;
  for (const [name, sha] of snapshot(out, skip)) {
    if (before.get(name) === sha) continue;
    const bytes = readFileSync(join(out, name));
    const text = bytes.toString('utf8');
    files[name] = Buffer.from(text, 'utf8').equals(bytes)
      ? { encoding: 'utf8', content: text }
      : { encoding: 'base64', content: bytes.toString('base64') };
  }
  return files;
}

export interface RecordingOptions {
  /** Where the recordings go. Made when it is missing. */
  readonly dir: string;
  /** Values masked in every form wherever they appear. A value under 8 characters would mask common words: leave it out. */
  readonly secrets: readonly string[];
  /** Paths masked beside the request's own, by the word that replaces each: `$RUNS`, `$REPO`, `$HOME`, `$TMPDIR`. */
  readonly roots: Readonly<Record<string, string>>;
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
  const secrets = redactor(options.secrets);
  return {
    name: inner.name,
    capabilities: () => inner.capabilities(),
    async run(request) {
      const { STAGE_IN: stageIn, STAGE_OUT: out } = request.env;
      const events: HarnessEvent[] = [];
      const raw: unknown[] = [];
      const before = snapshot(out, stageIn);
      let result: HarnessResult;
      try {
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
        const mask = maskPaths({ ...options.roots, ...requestRoots(request) });
        const recorded = RecordedTry.parse(
          secrets.value(
            mask({
              try: request.try,
              request: { model: request.model, budget: request.budget, promptSha256: promptSha256(request) },
              events,
              result: kept,
              files: changedFiles(out, before, stageIn),
              raw,
            }),
          ),
        );
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
