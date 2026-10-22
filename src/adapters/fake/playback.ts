// Playback: the fake Harness answering a session from its recording instead of a script (11.3 D7). It emits the
// recorded events in order, writes the recorded files into `$STAGE_OUT` and returns the recorded result, with no clock,
// network or credentials. Budgets aren't enforced: a recording is a fact, and plays as recorded. It never rejects.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Harness, HarnessEvent, HarnessRequest } from '../../ports/harness';
import type { HarnessResult } from '../../ports/types';
import { promptSha256, type RecordedTry, Recording, recordingFile } from '../recording';
import { placeFiles } from './harness';

export interface PlaybackOptions {
  /** The directory `--record` wrote. */
  readonly dir: string;
  /** What a prompt that differs from the recorded one does: fails the session (the default), or only warns. */
  readonly onPromptMismatch?: 'fail' | 'warn';
  /** Where a warning goes: stderr when left out. */
  readonly warn?: (line: string) => void;
}

const SHORT = 12;

/** The tries of `recording` that session `request.try` plays: the latest one at or before it, else the first. */
function tryFor(recording: Recording, wanted: number): RecordedTry {
  const earlier = recording.tries.filter((each) => each.try <= wanted);
  return earlier.at(-1) ?? (recording.tries[0] as RecordedTry);
}

export function createPlaybackHarness(options: PlaybackOptions): Harness {
  const mode = options.onPromptMismatch ?? 'fail';
  const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));

  /** What `request` plays: its recorded try, or the message of why there is none. */
  function load(request: HarnessRequest, file: string): { recorded: RecordedTry } | { message: string } {
    if (!existsSync(file)) return { message: `fake harness: nothing recorded for ${request.key} in ${options.dir}` };
    let recording: Recording;
    try {
      recording = Recording.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      return { message: `fake harness: ${file}: ${(error as Error).message}` };
    }
    if (recording.key !== request.key) {
      return { message: `fake harness: ${file} holds ${recording.key}, not ${request.key}` };
    }
    return { recorded: tryFor(recording, request.try) };
  }

  async function session(
    request: HarnessRequest,
    progress: { started: boolean; ended: boolean; events: HarnessEvent[] },
  ) {
    const file = recordingFile(options.dir, request.key);
    const fail = (message: string, recorded?: RecordedTry): Extract<HarnessResult, { outcome: 'error' }> => ({
      outcome: 'error',
      message,
      sessionId: recorded?.result.sessionId ?? '',
      usage: { costUsd: 0 },
      transcript: '',
      raw: null,
    });
    if (request.signal?.aborted) return fail('aborted');
    const loaded = load(request, file);
    if ('message' in loaded) return fail(loaded.message);
    const { recorded } = loaded;

    const now = promptSha256(request);
    if (now !== recorded.request.promptSha256) {
      const line = `fake harness: the prompt for ${request.key} differs from its recording (recorded ${recorded.request.promptSha256.slice(0, SHORT)}, now ${now.slice(0, SHORT)})`;
      if (mode === 'fail') return fail(line, recorded);
      warn(line);
    }

    // Where the files go is settled before the first event: a failure here emits nothing.
    const entries = Object.entries(recorded.files);
    let placed: [string, string][] = [];
    if (entries.length > 0) {
      const out = request.env.STAGE_OUT;
      if (out === undefined) return fail('fake harness: files need STAGE_OUT', recorded);
      const where = placeFiles(out, Object.fromEntries(entries.map(([name, each]) => [name, each.content])));
      if ('outside' in where) return fail(`fake harness: ${where.outside} is outside STAGE_OUT`, recorded);
      placed = where.paths;
    }

    const emit = (event: HarnessEvent) => {
      progress.events.push(event);
      if (event.type === 'harness:session_end') progress.ended = true;
      request.onEvent?.(event);
    };
    for (const event of recorded.events as HarnessEvent[]) {
      progress.started = true;
      emit(event);
      if (request.signal?.aborted === true) {
        const aborted = fail('aborted', recorded);
        end(request, progress, aborted);
        return aborted;
      }
    }
    placed.forEach(([path], index) => {
      mkdirSync(dirname(path), { recursive: true });
      const each = entries[index]?.[1];
      writeFileSync(path, each?.encoding === 'base64' ? Buffer.from(each.content, 'base64') : (each?.content ?? ''));
    });
    return { ...recorded.result, raw: { playback: file, try: recorded.try } } as HarnessResult;
  }

  return {
    name: 'fake',
    async run(request) {
      const progress = { started: false, ended: false, events: [] as HarnessEvent[] };
      try {
        return await session(request, progress);
      } catch (error) {
        // A harness never rejects (ADR-0008): a file that can't be written, or an onEvent that throws, is an error. A
        // session that started still ends, unless its onEvent won't listen.
        const message = `fake harness: ${error instanceof Error ? error.message : String(error)}`;
        const failed: HarnessResult = {
          outcome: 'error',
          message,
          sessionId: '',
          usage: { costUsd: 0 },
          transcript: '',
          raw: null,
        };
        end(request, progress, failed);
        return failed;
      }
    },
    capabilities: () => ({ structuredOutput: true, permissions: false, usage: true, abort: true, budgets: ['turns'] }),
  };
}

/** Ends a started session that the recording didn't end: the error, then one `harness:session_end`. */
function end(
  request: HarnessRequest,
  progress: { started: boolean; ended: boolean; events: HarnessEvent[] },
  failed: Extract<HarnessResult, { outcome: 'error' }>,
): void {
  if (!progress.started || progress.ended) return;
  const count = (type: HarnessEvent['type']) => progress.events.filter((event) => event.type === type).length;
  try {
    request.onEvent?.({ type: 'error:harness', message: failed.message });
    request.onEvent?.({
      type: 'harness:session_end',
      sessionId: failed.sessionId,
      outcome: 'error',
      reason: 'failed',
      turns: count('usage:update'),
      toolCalls: count('tool:start'),
      denials: count('permission:denied'),
      usage: failed.usage,
    });
  } catch {
    // An onEvent that throws hears no more.
  }
}
