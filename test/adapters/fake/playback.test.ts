// Playback: the fake harness answers a session from the recording the recorder wrote (11.3 D7). Each case records a
// scripted fake session first, then plays it back in a fresh call directory, so the two are compared event for event.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeHarness, type HarnessScript } from '../../../src/adapters/fake/harness';
import { createPlaybackHarness } from '../../../src/adapters/fake/playback';
import { type Recording, recordingFile, recordingHarness } from '../../../src/adapters/recording';
import type { Harness, HarnessEvent, HarnessRequest } from '../../../src/ports/harness';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-playback-')));
  dirs.push(dir);
  return dir;
}

function request(key = 'spec#1', tryNumber = 1, prompt = 'Write the spec.'): HarnessRequest {
  const root = tempDir();
  const [cwd, stageIn, stageOut] = ['work', 'in', 'out'].map((name) => join(root, name)) as [string, string, string];
  for (const path of [cwd, stageIn, stageOut]) mkdirSync(path);
  return {
    key,
    try: tryNumber,
    prompt,
    cwd,
    env: { STAGE_IN: stageIn, STAGE_OUT: stageOut },
    model: 'fake-model',
    permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
    budget: { maxTurns: 5, maxUsd: 1, maxMinutes: 5 },
    outputSchema: { type: 'object' },
  };
}

const USAGE = { costUsd: 0.4, inputTokens: 100, outputTokens: 50 };
const SCRIPT: HarnessScript = {
  'spec#1': [
    {
      outcome: 'done',
      output: { summary: 'first' },
      messages: ['Reading the brief.', 'Writing.'],
      turns: 2,
      usage: USAGE,
      files: { 'spec.md': '# Spec\n', 'notes/more.txt': 'more' },
    },
    { outcome: 'done', output: { summary: 'second' }, messages: ['Again.'], usage: USAGE },
  ],
};

/** Records `script`'s sessions for `requests`, in order, and returns the directory. */
async function record(requests: HarnessRequest[], script: HarnessScript = SCRIPT, inner?: Harness): Promise<string> {
  const dir = join(tempDir(), 'rec');
  const harness = recordingHarness(inner ?? createFakeHarness({ script }), { dir, secrets: [], roots: {} });
  for (const req of requests) await harness.run(req);
  return dir;
}

/** Runs `req` on `harness`, returning its events and result. */
async function play(harness: Harness, req: HarnessRequest, extra: Partial<HarnessRequest> = {}) {
  const events: HarnessEvent[] = [];
  const result = await harness.run({ ...req, onEvent: (event) => events.push(event), ...extra });
  return { events, result };
}

const tree = (out: string | undefined): Record<string, string> => {
  const found: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else found[`${prefix}${entry.name}`] = readFileSync(join(dir, entry.name), 'utf8');
    }
  };
  if (out !== undefined) walk(out, '');
  return found;
};

describe('a recorded session plays back as it ran', () => {
  test('the same events, result and files', async () => {
    const recorded = request();
    const direct = await play(createFakeHarness({ script: SCRIPT }), recorded);
    const dir = await record([request()]);
    const replayed = request();
    const played = await play(createPlaybackHarness({ dir }), replayed);
    expect(played.events).toEqual(direct.events);
    const { raw: _a, ...want } = direct.result;
    const { raw: _b, ...got } = played.result;
    expect(got).toEqual(want);
    expect(tree(replayed.env.STAGE_OUT)).toEqual({ 'spec.md': '# Spec\n', 'notes/more.txt': 'more' });
    expect(played.result.raw).toEqual({ playback: recordingFile(dir, 'spec#1'), try: 1 });
  });

  test('a binary file is written back as its bytes', async () => {
    const bytes = Buffer.from([0xff, 0x00, 0xfe, 0x41]);
    const inner: Harness = {
      ...createFakeHarness({ script: SCRIPT }),
      run: async (req) => {
        writeFileSync(join(req.env.STAGE_OUT ?? '', 'blob.bin'), bytes);
        return createFakeHarness({ script: SCRIPT }).run(req);
      },
    };
    const dir = await record([request()], SCRIPT, inner);
    const again = request();
    await play(createPlaybackHarness({ dir }), again);
    expect(readFileSync(join(again.env.STAGE_OUT ?? '', 'blob.bin')).equals(bytes)).toBe(true);
  });

  test('a recording of a harness named otherwise plays under the fake harness name', () => {
    expect(createPlaybackHarness({ dir: 'x' }).name).toBe('fake');
    expect(createPlaybackHarness({ dir: 'x' }).capabilities().structuredOutput).toBe(true);
  });
});

describe('which try plays', () => {
  test('try 3 of a key recorded with two tries plays try 2, and try 1 plays try 1', async () => {
    const dir = await record([request('spec#1', 1), request('spec#1', 2)]);
    const harness = createPlaybackHarness({ dir });
    const outputs = [];
    for (const n of [1, 2, 3]) {
      const { result } = await play(harness, request('spec#1', n));
      outputs.push(result.outcome === 'done' ? result.output : result.outcome);
    }
    expect(outputs).toEqual([{ summary: 'first' }, { summary: 'second' }, { summary: 'second' }]);
  });

  test('a recording with only a later try plays it for an earlier one', async () => {
    const dir = await record([request('spec#1', 2)]);
    const { result } = await play(createPlaybackHarness({ dir }), request('spec#1', 1));
    expect(result.outcome === 'done' && result.output).toEqual({ summary: 'second' });
  });
});

describe('what cannot be played', () => {
  test('a key with no recording is an error with no event', async () => {
    const dir = await record([request()]);
    const { events, result } = await play(createPlaybackHarness({ dir }), request('implement#1'));
    expect(events).toEqual([]);
    expect(result).toMatchObject({
      outcome: 'error',
      message: `fake harness: nothing recorded for implement#1 in ${dir}`,
    });
  });

  test('a file whose key differs, and a file zod refuses, are errors with no event', async () => {
    const dir = await record([request()]);
    const text = readFileSync(recordingFile(dir, 'spec#1'), 'utf8');
    writeFileSync(recordingFile(dir, 'implement#1'), text);
    writeFileSync(recordingFile(dir, 'self-review#1'), '{"recording":1,"key":"self-review#1","tries":[]}');
    writeFileSync(recordingFile(dir, 'describe#1'), 'not json');
    const messages: string[] = [];
    for (const key of ['implement#1', 'self-review#1', 'describe#1']) {
      const { events, result } = await play(createPlaybackHarness({ dir }), request(key));
      expect(events).toEqual([]);
      messages.push(result.outcome === 'error' ? result.message : 'played');
    }
    expect(messages[0]).toContain('holds spec#1, not implement#1');
    expect(messages[1]).toContain('self-review#1.json');
    expect(messages[2]).toContain('describe#1.json');
  });

  test('a request already aborted is an error with no event', async () => {
    const dir = await record([request()]);
    const { events, result } = await play(createPlaybackHarness({ dir }), request(), { signal: AbortSignal.abort() });
    expect(events).toEqual([]);
    expect(result).toMatchObject({ outcome: 'error', message: 'aborted' });
  });
});

describe('a prompt that differs from the recording', () => {
  const changed = () => request('spec#1', 1, 'Write the spec, differently.');

  test('fails the session under fail, the default, naming both hashes, with no event', async () => {
    const dir = await record([request()]);
    const target = request('spec#1', 1, 'Write the spec, differently.');
    const { events, result } = await play(createPlaybackHarness({ dir }), target);
    expect(events).toEqual([]);
    expect(result.outcome === 'error' && result.message).toMatch(
      /^fake harness: the prompt for spec#1 differs from its recording \(recorded [0-9a-f]{12}, now [0-9a-f]{12}\)$/,
    );
    expect(tree(target.env.STAGE_OUT)).toEqual({});
  });

  test('only warns under warn, once, and then plays in full', async () => {
    const dir = await record([request()]);
    const warned: string[] = [];
    const harness = createPlaybackHarness({ dir, onPromptMismatch: 'warn', warn: (line) => warned.push(line) });
    const target = changed();
    const { events, result } = await play(harness, target);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/spec#1.*recorded [0-9a-f]{12}, now [0-9a-f]{12}/);
    expect(result.outcome).toBe('done');
    expect(events.at(-1)?.type).toBe('harness:session_end');
    expect(Object.keys(tree(target.env.STAGE_OUT))).toEqual(['notes/more.txt', 'spec.md']);
  });

  test('warn writes to stderr when no warn is given', async () => {
    const dir = await record([request()]);
    const written: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await play(createPlaybackHarness({ dir, onPromptMismatch: 'warn' }), changed());
    } finally {
      process.stderr.write = original;
    }
    expect(written.join('')).toContain('differs from its recording');
  });

  test('the same prompt in another place plays without a warning', async () => {
    const dir = await record([request()]);
    const warned: string[] = [];
    await play(createPlaybackHarness({ dir, onPromptMismatch: 'warn', warn: (line) => warned.push(line) }), request());
    expect(warned).toEqual([]);
  });
});

describe('an abort and a bad file', () => {
  test('an abort after the second event ends the session as aborted, with one end and no file', async () => {
    const dir = await record([request()]);
    const controller = new AbortController();
    const target = request();
    const events: HarnessEvent[] = [];
    const result = await createPlaybackHarness({ dir }).run({
      ...target,
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (events.length === 2) controller.abort();
      },
    });
    expect(result).toMatchObject({ outcome: 'error', message: 'aborted' });
    expect(events.map((event) => event.type)).toEqual([
      'harness:session_start',
      'agent:message',
      'error:harness',
      'harness:session_end',
    ]);
    expect(events.filter((event) => event.type === 'harness:session_end')).toHaveLength(1);
    expect(tree(target.env.STAGE_OUT)).toEqual({});
  });

  test('an abort on the very last recorded event adds no second end', async () => {
    const dir = await record([request()]);
    const controller = new AbortController();
    const events: HarnessEvent[] = [];
    const result = await createPlaybackHarness({ dir }).run({
      ...request(),
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'harness:session_end') controller.abort();
      },
    });
    expect(result).toMatchObject({ outcome: 'error', message: 'aborted' });
    expect(events.filter((event) => event.type === 'harness:session_end')).toHaveLength(1);
  });

  test('a recorded file named outside STAGE_OUT is an error, and nothing is written outside', async () => {
    const dir = await record([request()]);
    const file = recordingFile(dir, 'spec#1');
    const recording = JSON.parse(readFileSync(file, 'utf8')) as Recording;
    const first = recording.tries[0];
    if (first === undefined) throw new Error('no try');
    first.files = { '../escape.md': { encoding: 'utf8', content: 'x' } };
    writeFileSync(file, JSON.stringify(recording));
    const target = request();
    const { events, result } = await play(createPlaybackHarness({ dir }), target);
    expect(events).toEqual([]);
    expect(result.outcome === 'error' && result.message).toBe('fake harness: ../escape.md is outside STAGE_OUT');
    expect(existsSync(join(target.env.STAGE_OUT ?? '', '..', 'escape.md'))).toBe(false);
  });

  test('recorded files with no STAGE_OUT are an error', async () => {
    const dir = await record([request()]);
    const target = request();
    const { events, result } = await play(createPlaybackHarness({ dir }), { ...target, env: {} });
    expect(events).toEqual([]);
    expect(result.outcome === 'error' && result.message).toBe('fake harness: files need STAGE_OUT');
  });

  test('an onEvent that throws ends the session as an error and never rejects', async () => {
    const dir = await record([request()]);
    const heard: HarnessEvent[] = [];
    const result = await createPlaybackHarness({ dir }).run({
      ...request(),
      onEvent: (event) => {
        heard.push(event);
        if (heard.length === 2) throw new Error('consumer broke');
        if (heard.length > 2) throw new Error('still broken');
      },
    });
    expect(result).toMatchObject({ outcome: 'error', message: 'fake harness: consumer broke' });
  });

  test('a file that cannot be written is an error carrying the cause', async () => {
    const dir = await record([request()]);
    const target = request();
    writeFileSync(join(target.env.STAGE_OUT ?? '', 'notes'), 'a file where a directory should go');
    const { result } = await play(createPlaybackHarness({ dir }), target);
    expect(result.outcome).toBe('error');
    expect(result.outcome === 'error' && result.message).toMatch(/^fake harness: /);
  });

  test('a throw that is not an Error is an error with its text', async () => {
    const dir = await record([request()]);
    const result = await createPlaybackHarness({ dir }).run({
      ...request(),
      onEvent: () => {
        throw 'plain';
      },
    });
    expect(result.outcome === 'error' && result.message).toBe('fake harness: plain');
  });
});

describe('a blocked session', () => {
  test('plays back blocked with its reason', async () => {
    const script: HarnessScript = { 'spec#1': [{ outcome: 'blocked', reason: 'No criteria.', messages: ['hm'] }] };
    const dir = await record([request()], script);
    const { result } = await play(createPlaybackHarness({ dir }), request());
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'No criteria.' });
  });
});
