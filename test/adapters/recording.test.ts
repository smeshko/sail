// The recorder: a Harness that runs every session on the harness it wraps, and writes each try into its call key's
// recording, masked of secrets and machine paths (11.3 D2 to D6). The inner harness is a stand-in that writes files and
// emits events, so each case sees exactly what the recorder saw.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  maskPaths,
  promptSha256,
  Recording,
  recordingFile,
  recordingHarness,
  writeJournalKeys,
} from '../../src/adapters/recording';
import { appendJournal, createJournal } from '../../src/engine/journal';
import type { Harness, HarnessEvent, HarnessRequest } from '../../src/ports/harness';
import type { HarnessResult } from '../../src/ports/types';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-recording-')));
  dirs.push(dir);
  return dir;
}

/** A request for `key` in directories of its own: `in/`, `out/` and `work/` under one temp directory. */
function request(key = 'spec#1', extra: Partial<HarnessRequest> = {}): HarnessRequest & { root: string } {
  const root = tempDir();
  const [cwd, stageIn, stageOut] = ['work', 'in', 'out'].map((name) => join(root, name)) as [string, string, string];
  for (const path of [cwd, stageIn, stageOut]) mkdirSync(path);
  return {
    root,
    key,
    try: 1,
    prompt: `Write the spec. Notes are in ${stageIn}/brief.md.`,
    cwd,
    env: { STAGE_IN: stageIn, STAGE_OUT: stageOut },
    model: 'fake-model',
    permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
    budget: { maxTurns: 5, maxUsd: 1, maxMinutes: 5 },
    outputSchema: { type: 'object' },
    ...extra,
  };
}

const USAGE = { inputTokens: 10, outputTokens: 20, costUsd: 0.5 };

/** What a stand-in session does: writes `files` into `$STAGE_OUT`, emits `events`, hands `raw` on, and ends `result`. */
interface Session {
  files?: Record<string, string | Buffer>;
  events?: HarnessEvent[];
  raw?: unknown[];
  output?: unknown;
}

function standIn(session: Session = {}): Harness {
  return {
    name: 'stand-in',
    capabilities: () => ({ structuredOutput: true, permissions: true, usage: true, abort: true, budgets: ['turns'] }),
    async run(req) {
      for (const [name, content] of Object.entries(session.files ?? {})) {
        const path = join(req.env.STAGE_OUT ?? '', name);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, content);
      }
      for (const event of session.events ?? []) req.onEvent?.(event);
      for (const message of session.raw ?? []) req.onRaw?.(message);
      return {
        outcome: 'done',
        output: session.output ?? { summary: 'ok' },
        sessionId: 's1',
        usage: USAGE,
        transcript: 'assistant: hi',
        raw: { secretly: 'unrecorded' },
      };
    },
  };
}

const START: HarnessEvent = {
  type: 'harness:session_start',
  adapter: 'stand-in',
  sessionId: 's1',
  model: 'fake-model',
};
const SAID = (text: string): HarnessEvent => ({ type: 'agent:message', text });

function recorder(inner: Harness, over: { secrets?: string[]; roots?: Record<string, string> } = {}) {
  const dir = join(tempDir(), 'rec');
  return { dir, harness: recordingHarness(inner, { dir, secrets: over.secrets ?? [], roots: over.roots ?? {} }) };
}

const read = (dir: string, key: string): Recording =>
  Recording.parse(JSON.parse(readFileSync(recordingFile(dir, key), 'utf8')));

/** Every byte under `dir`, as one string. */
const bytes = (dir: string): string =>
  readdirSync(dir)
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');

describe('what a done session records', () => {
  test('one try holds the request, the events, the result without raw, and exactly the file it wrote', async () => {
    const req = request();
    const seen: HarnessEvent[] = [];
    const { dir, harness } = recorder(
      standIn({ files: { 'spec.md': '# Spec\n' }, events: [START, SAID('hello')], raw: [{ n: 1 }] }),
    );
    const result = await harness.run({ ...req, onEvent: (event) => seen.push(event) });
    expect(result.outcome).toBe('done');
    expect(seen).toEqual([START, SAID('hello')]);
    const file = read(dir, 'spec#1');
    expect(readdirSync(dir)).toEqual(['spec#1.json']);
    expect(file.tries).toHaveLength(1);
    const [recorded] = file.tries;
    expect(recorded?.request).toEqual({
      model: 'fake-model',
      budget: { maxTurns: 5, maxUsd: 1, maxMinutes: 5 },
      promptSha256: promptSha256(req),
    });
    expect(recorded?.events).toEqual([START, SAID('hello')]);
    expect(recorded?.result).toEqual({
      outcome: 'done',
      output: { summary: 'ok' },
      sessionId: 's1',
      usage: USAGE,
      transcript: 'assistant: hi',
    });
    expect(recorded?.files).toEqual({ 'spec.md': { encoding: 'utf8', content: '# Spec\n' } });
    expect(recorded?.raw).toEqual([{ n: 1 }]);
  });

  test('the file ends with a newline and is two-space JSON', async () => {
    const { dir, harness } = recorder(standIn());
    await harness.run(request());
    const text = readFileSync(recordingFile(dir, 'spec#1'), 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  });

  test('the name and capabilities are the inner harness', () => {
    const { harness } = recorder(standIn());
    expect(harness.name).toBe('stand-in');
    expect(harness.capabilities().budgets).toEqual(['turns']);
  });

  test('a harness that hands no raw messages records an empty list', async () => {
    const { dir, harness } = recorder(standIn());
    await harness.run(request());
    expect(read(dir, 'spec#1').tries[0]?.raw).toEqual([]);
  });

  test('the raw messages a harness hands onRaw are recorded in order, and still reach the caller', async () => {
    const heard: unknown[] = [];
    const { dir, harness } = recorder(standIn({ raw: [{ n: 1 }, { n: 2 }, { n: 3 }] }));
    await harness.run({ ...request(), onRaw: (message) => heard.push(message) });
    expect(read(dir, 'spec#1').tries[0]?.raw).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(heard).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test('a blocked and an error result are recorded as they ended', async () => {
    const ends: HarnessResult[] = [
      { outcome: 'blocked', reason: 'No criteria.', sessionId: 's', usage: USAGE, transcript: 't', raw: null },
      {
        outcome: 'error',
        message: 'boom',
        reason: 'budget_exceeded',
        sessionId: 's',
        usage: USAGE,
        transcript: 't',
        raw: null,
      },
    ];
    for (const end of ends) {
      const { dir, harness } = recorder({ ...standIn(), run: async () => end });
      expect((await harness.run(request())).outcome).toBe(end.outcome);
      const { raw: _raw, ...kept } = end;
      expect(read(dir, 'spec#1').tries[0]?.result).toEqual(kept);
    }
  });
});

describe('which files are recorded', () => {
  test('a file written before the session, one under STAGE_IN, and an untouched file are left out; a completed one is in', async () => {
    const req = request();
    const out = req.env.STAGE_OUT ?? '';
    writeFileSync(join(out, 'prompt.md'), 'the prompt');
    writeFileSync(join(out, 'template.md'), 'untouched');
    writeFileSync(join(out, 'form.md'), '- [ ] filled in by the session');
    const inner: Harness = {
      ...standIn(),
      run: async (r) => {
        writeFileSync(join(out, 'form.md'), '- [x] filled in by the session');
        writeFileSync(join(r.env.STAGE_IN ?? '', 'noise.md'), 'input');
        return (await standIn({ files: { 'nested/new.txt': 'new' } }).run(r)) as HarnessResult;
      },
    };
    const { dir, harness } = recorder(inner);
    await harness.run(req);
    expect(Object.keys(read(dir, 'spec#1').tries[0]?.files ?? {}).sort()).toEqual(['form.md', 'nested/new.txt']);
  });

  test('a STAGE_IN inside STAGE_OUT is left out too', async () => {
    const req = request();
    const out = req.env.STAGE_OUT ?? '';
    const stageIn = join(out, 'in');
    mkdirSync(stageIn);
    const inner: Harness = {
      ...standIn(),
      run: async (r) => {
        writeFileSync(join(stageIn, 'deep.md'), 'input');
        return standIn({ files: { 'out.md': 'x' } }).run(r);
      },
    };
    const { dir, harness } = recorder(inner);
    await harness.run({ ...req, env: { ...req.env, STAGE_IN: stageIn } });
    expect(Object.keys(read(dir, 'spec#1').tries[0]?.files ?? {})).toEqual(['out.md']);
  });

  test('a file that is not UTF-8 is base64 and decodes to its bytes', async () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41]);
    const { dir, harness } = recorder(standIn({ files: { 'blob.bin': binary } }));
    await harness.run(request());
    const file = read(dir, 'spec#1').tries[0]?.files['blob.bin'];
    expect(file?.encoding).toBe('base64');
    expect(Buffer.from(file?.content ?? '', 'base64').equals(binary)).toBe(true);
  });

  test('a request without STAGE_OUT records no files', async () => {
    const req = request();
    const { dir, harness } = recorder({ ...standIn(), run: async () => standIn().run(req) });
    await harness.run({ ...req, env: {} });
    expect(read(dir, 'spec#1').tries[0]?.files).toEqual({});
  });
});

describe('tries and keys', () => {
  test('try 2 of a key keeps try 1, in order, and a repeated try replaces its own', async () => {
    const { dir, harness } = recorder(standIn({ output: { n: 1 } }));
    const second = recordingHarness(standIn({ output: { n: 2 } }), { dir, secrets: [], roots: {} });
    await harness.run(request('spec#1'));
    await second.run({ ...request('spec#1'), try: 2 });
    await recordingHarness(standIn({ output: { n: 3 } }), { dir, secrets: [], roots: {} }).run(request('spec#1'));
    const tries = read(dir, 'spec#1').tries;
    expect(tries.map((each) => each.try)).toEqual([1, 2]);
    expect(tries.map((each) => (each.result as { output: unknown }).output)).toEqual([{ n: 3 }, { n: 2 }]);
  });

  test('a key with a step is written with a plus', async () => {
    const { dir, harness } = recorder(standIn());
    await harness.run(request('publish#1/describe'));
    expect(readdirSync(dir)).toEqual(['publish#1+describe.json']);
    expect(read(dir, 'publish#1/describe').key).toBe('publish#1/describe');
    expect(recordingFile('d', 'publish#1/describe')).toBe(join('d', 'publish#1+describe.json'));
  });

  test('a file that holds another key is an error, and the file is left alone', async () => {
    const { dir, harness } = recorder(standIn());
    await harness.run(request('spec#1'));
    const text = readFileSync(recordingFile(dir, 'spec#1'), 'utf8');
    writeFileSync(recordingFile(dir, 'implement#1'), text);
    const result = await harness.run(request('implement#1'));
    expect(result.outcome === 'error' && result.message).toContain('recording: ');
    expect(readFileSync(recordingFile(dir, 'implement#1'), 'utf8')).toBe(text);
  });
});

describe('masking secrets', () => {
  const SECRET = 'sk-ant-oat01-AbCdEf0123456789xYzQ-_tokenvalue+/==';
  const asWritten = SECRET;
  const urlEncoded = encodeURIComponent(SECRET);
  const padded = Buffer.from(SECRET).toString('base64');
  const unpadded = padded.replace(/=+$/, '');
  const forms = [asWritten, urlEncoded, padded, unpadded];

  test('a secret in every form is masked wherever it appears, in the file only', async () => {
    const req = request();
    const heard: HarnessEvent[] = [];
    const events: HarnessEvent[] = [
      START,
      SAID(`use ${asWritten}`),
      { type: 'tool:start', callId: 't', tool: 'Bash', input: { command: `curl -H ${urlEncoded}` } },
    ];
    const inner = standIn({
      events,
      files: { 'notes.md': `token ${padded}` },
      raw: [{ message: { content: [{ type: 'tool_result', content: `echo ${unpadded}` }] } }],
      output: { echoed: asWritten },
    });
    const wrapped: Harness = {
      ...inner,
      run: async (r) => ({ ...(await inner.run(r)), transcript: `assistant: ${padded}` }) as HarnessResult,
    };
    const { dir, harness } = recorder(wrapped, { secrets: [SECRET] });
    const result = await harness.run({ ...req, onEvent: (event) => heard.push(event) });
    const text = bytes(dir);
    for (const form of forms) expect(text).not.toContain(form);
    expect(text).toContain('[redacted]');
    expect(JSON.stringify(heard)).toContain(asWritten);
    expect(result.outcome === 'done' && JSON.stringify(result.output)).toContain(asWritten);
    const recorded = read(dir, 'spec#1').tries[0];
    expect(recorded?.files['notes.md']?.content).toBe('token [redacted]');
    expect(JSON.stringify(recorded?.result)).not.toContain(SECRET);
  });

  test('a shape of real-looking tokens is masked: an OAuth token, a GitHub token and a Linear key', async () => {
    const tokens = [
      'sk-ant-oat01-Zk3b9QfVwX7mLp2RtYh8NcDe5GaJ1uSo4IiKq6TnUBvMxCyPdWlOrEAz0H-9_fgjhwQAA',
      `ghp_${'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6'}`,
      `lin_api_${'Qw3Er5Ty7Ui9Op1As3Df5Gh7Jk9Lz1Xc3Vb5Nm7'}`,
    ];
    const { dir, harness } = recorder(
      standIn({ events: tokens.map((token) => SAID(`got ${token}`)), output: { tokens } }),
      { secrets: tokens },
    );
    await harness.run(request());
    const text = bytes(dir);
    for (const token of tokens) expect(text).not.toContain(token);
    expect(text.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(6);
  });
});

describe('masking machine paths', () => {
  test('each root is replaced in a tool input and a raw message, and no temp path is left', async () => {
    const req = request();
    const extra = tempDir();
    const home = join(extra, 'home');
    const repo = join(extra, 'repo');
    const runs = join(repo, '.sail-runs');
    for (const path of [home, repo, runs]) mkdirSync(path, { recursive: true });
    const events: HarnessEvent[] = [
      START,
      {
        type: 'tool:start',
        callId: 't',
        tool: 'Read',
        input: {
          file_path: `${req.cwd}/src/a.ts`,
          also: [`${req.env.STAGE_IN}/brief.md`, `${req.env.STAGE_OUT}/spec.md`],
        },
      },
    ];
    const raw = [{ text: `${home}/.config and ${runs}/x and ${repo}/src and ${tmpdir()}/loose` }];
    const { dir, harness } = recorder(standIn({ events, raw }), {
      roots: { $HOME: home, $REPO: repo, $RUNS: runs, $TMPDIR: `${tmpdir()}/` },
    });
    await harness.run(req);
    const text = bytes(dir);
    for (const path of [req.root, extra, home, repo, runs]) expect(text).not.toContain(path);
    expect(text).toContain('$WORKSPACE/src/a.ts');
    expect(text).toContain('$STAGE_IN/brief.md');
    expect(text).toContain('$STAGE_OUT/spec.md');
    expect(text).toContain('$HOME/.config');
    expect(text).toContain('$RUNS/x');
    expect(text).toContain('$REPO/src');
    expect(text).toContain('$TMPDIR/loose');
  });

  test('the realpath form of a symlinked root is replaced too', () => {
    const real = tempDir();
    const link = join(tempDir(), 'link');
    require('node:fs').symlinkSync(real, link);
    const mask = maskPaths({ $ROOT: link });
    expect(mask({ [`${real}/k`]: `${real}/x and ${link}/y` })).toEqual({ '$ROOT/k': '$ROOT/x and $ROOT/y' });
  });

  test('a root that is the filesystem root, or does not exist, masks nothing it should not', () => {
    const mask = maskPaths({ $ROOT: '/', $GONE: '/no/such/dir-xyz' });
    expect(mask({ a: '/usr/bin and /no/such/dir-xyz/f', n: 3, ok: true, none: null })).toEqual({
      a: '/usr/bin and $GONE/f',
      n: 3,
      ok: true,
      none: null,
    });
  });

  test('the prompt hash does not depend on where the request lives', () => {
    const [a, b] = [request(), request()];
    const prompt = (r: ReturnType<typeof request>) =>
      `Work in ${r.cwd}, read ${r.env.STAGE_IN}/x, write ${r.env.STAGE_OUT}/y.`;
    expect(promptSha256({ ...a, prompt: prompt(a) })).toBe(promptSha256({ ...b, prompt: prompt(b) }));
    expect(promptSha256({ ...a, prompt: 'other' })).not.toBe(promptSha256({ ...b, prompt: prompt(b) }));
    expect(promptSha256({ ...a, prompt: 'x' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('failures never reject', () => {
  test('a directory that cannot be written turns a done result into a harness error that keeps the usage', async () => {
    const blocker = join(tempDir(), 'file');
    writeFileSync(blocker, 'not a directory');
    const harness = recordingHarness(standIn(), { dir: join(blocker, 'rec'), secrets: [], roots: {} });
    const result = await harness.run(request());
    expect(result).toMatchObject({
      outcome: 'error',
      reason: 'harness',
      usage: USAGE,
      sessionId: 's1',
      transcript: 'assistant: hi',
    });
    expect(result.outcome === 'error' && result.message.startsWith('recording:')).toBe(true);
  });

  test('a recording file zod refuses is an error naming the problem', async () => {
    const { dir, harness } = recorder(standIn());
    mkdirSync(dir, { recursive: true });
    writeFileSync(recordingFile(dir, 'spec#1'), '{"recording":2}');
    const result = await harness.run(request());
    expect(result.outcome === 'error' && result.message).toContain('recording:');
  });

  test('a rejecting inner harness is an error result, an Error or not', async () => {
    for (const thrown of [new Error('exploded'), 'plain string']) {
      const { harness } = recorder({
        ...standIn(),
        run: async () => {
          throw thrown;
        },
      });
      const result = await harness.run(request());
      expect(result).toMatchObject({ outcome: 'error', reason: 'harness' });
      expect(result.outcome === 'error' && result.message).toBe(
        `recording: ${thrown instanceof Error ? thrown.message : thrown}`,
      );
    }
  });
});

describe('writeJournalKeys', () => {
  test('writes one key and outcome line per journal line', () => {
    const runDir = tempDir();
    createJournal(runDir);
    const entry = (key: string, stage: string, call: number, outcome: 'passed' | 'done' | 'failed', step?: string) =>
      appendJournal(runDir, {
        key,
        stage,
        call,
        ...(step === undefined ? {} : { step }),
        outcome,
        output: null,
        reason: null,
        files: {},
        resultPath: `${stage}/call-${call}/result.json`,
      });
    entry('spec#1', 'spec', 1, 'done');
    entry('tests#1', 'tests', 1, 'failed');
    entry('publish#1/describe', 'publish', 1, 'done', 'describe');
    const dir = join(tempDir(), 'rec');
    writeJournalKeys(dir, runDir);
    expect(readFileSync(join(dir, 'journal.txt'), 'utf8')).toBe(
      'spec#1 done\ntests#1 failed\npublish#1/describe done\n',
    );
  });
});
