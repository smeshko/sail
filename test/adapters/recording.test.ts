// The recorder: a Harness that runs every session on the harness it wraps, and writes each try into its call key's
// recording, masked of secrets and machine paths (11.3 D2 to D6). The inner harness is a stand-in that writes files and
// emits events, so each case sees exactly what the recorder saw.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
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

test('recordings preserve an optional idle limit', async () => {
  const dir = tempDir();
  const harness = recordingHarness(standIn(), { dir, secrets: [], roots: {} });
  await harness.run(request('spec#1', { budget: { maxTurns: 5, maxUsd: 1, maxMinutes: 5, maxIdleMinutes: 0.02 } }));
  expect(read(dir, 'spec#1').tries[0]?.request.budget.maxIdleMinutes).toBe(0.02);
});

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

  test('the files are recorded in name order, whatever order the directory lists them in (review #1.1)', async () => {
    const files = { 'z.md': 'z', 'notes.txt': 'n', 'spec.md': 's', 'm/b.md': 'b', 'a.md': 'a' };
    const { dir, harness } = recorder(standIn({ files }));
    await harness.run(request());
    expect(Object.keys(read(dir, 'spec#1').tries[0]?.files ?? {})).toEqual([
      'a.md',
      'm/b.md',
      'notes.txt',
      'spec.md',
      'z.md',
    ]);
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

  test('a file that is not UTF-8 has the secret and the paths in its bytes masked, at any offset (review #1.2)', async () => {
    const req = request();
    const home = tempDir();
    const binary = (lead: number) =>
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.alloc(lead, 0x41),
        Buffer.from(`${SECRET} in ${req.cwd}/a and ${home}/b`),
        Buffer.from([0x80]),
      ]);
    const files = { 'a.bin': binary(0), 'b.bin': binary(1), 'c.bin': binary(2) };
    const { dir, harness } = recorder(standIn({ files }), { secrets: [SECRET], roots: { $HOME: home } });
    expect((await harness.run(req)).outcome).toBe('done');
    for (const name of Object.keys(files)) {
      const file = read(dir, 'spec#1').tries[0]?.files[name];
      expect(file?.encoding).toBe('base64');
      const decoded = Buffer.from(file?.content ?? '', 'base64').toString('latin1');
      expect(decoded).not.toContain(SECRET);
      expect(decoded).not.toContain(req.root);
      expect(decoded).not.toContain(home);
      expect(decoded).toContain('[redacted] in $WORKSPACE/a and $HOME/b');
    }
  });

  test('base64 of a secret inside a longer value is masked at every offset, followed by more or not (review #1.3)', async () => {
    const encoded = ['', 'u:', 'jdoe:'].flatMap((lead) =>
      ['', 'x', '\n'].map((tail) => Buffer.from(`${lead}${SECRET}${tail}`).toString('base64')),
    );
    const { dir, harness } = recorder(standIn({ events: encoded.map((text) => SAID(`Basic ${text}`)) }), {
      secrets: [SECRET],
    });
    await harness.run(request());
    const said = read(dir, 'spec#1').tries[0]?.events.map((event) => String(event.text)) ?? [];
    expect(said).toHaveLength(encoded.length);
    for (const text of said) {
      expect(text).toContain('[redacted]');
      const left = Buffer.from(text.slice('Basic '.length).split('[redacted]').join(''), 'base64').toString('latin1');
      expect(left).not.toContain(SECRET.slice(2, -2));
    }
  });

  test('a secret JSON-escaped inside a JSON text is masked, quotes, backslashes and newlines included (review #1.4)', async () => {
    const tricky = 'pa"ss\\wo/rd\nline-2-xyz';
    const content = JSON.stringify({ password: tricky });
    const { dir, harness } = recorder(
      standIn({ files: { 'creds.json': content }, raw: [{ type: 'user', content: [{ tool_result: content }] }] }),
      { secrets: [tricky] },
    );
    await harness.run(request());
    const recorded = JSON.stringify(read(dir, 'spec#1').tries[0]);
    expect(recorded).not.toContain(JSON.stringify(tricky).slice(1, -1));
    expect(recorded).not.toContain('line-2-xyz');
    expect(read(dir, 'spec#1').tries[0]?.files['creds.json']?.content).toBe('{"password":"[redacted]"}');
  });

  test('a secret that holds a root path is masked whole, before the paths are (review #1.5)', async () => {
    const secret = 'Zq9/x9-root/Kw7Lm2Np';
    const { dir, harness } = recorder(standIn({ events: [SAID(`key ${secret}`)] }), {
      secrets: [secret],
      roots: { $ROOT: '/x9-root' },
    });
    await harness.run(request());
    expect(read(dir, 'spec#1').tries[0]?.events).toEqual([SAID('key [redacted]')]);
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

  test('a root URL-encoded or dashed as Claude Code names a project folder is replaced, and the login as a word (review #1.6)', async () => {
    const req = request();
    const home = join(tempDir(), 'Users', 'Jdoe Smith');
    mkdirSync(home, { recursive: true });
    const dashed = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-');
    const events: HarnessEvent[] = [
      SAID(`open ${encodeURIComponent(`${home}/notes`)}`),
      SAID(`file://${encodeURI(home)}/notes.md`),
      SAID(`${home}/.claude/projects/${dashed(req.cwd)}/s1.jsonl`),
      SAID('-rw-r--r--  1 jdoe  staff  12 notes.md; /Users/JDOE/x; jdoes stays'),
    ];
    const rec = join(tempDir(), 'rec');
    await recordingHarness(standIn({ events }), {
      dir: rec,
      secrets: [],
      roots: { $HOME: home },
      names: { $USER: 'jdoe', $SHORT: 'jd' },
    }).run(req);
    expect(read(rec, 'spec#1').tries[0]?.events).toEqual([
      SAID(`open $HOME%2Fnotes`),
      SAID('file://$HOME/notes.md'),
      SAID('$HOME/.claude/projects/$WORKSPACE/s1.jsonl'),
      SAID('-rw-r--r--  1 $USER  staff  12 notes.md; /Users/$USER/x; jdoes stays'),
    ]);
  });

  test('a login that is also a protocol word is masked only where a path or a listing carries it (review #2.3)', async () => {
    for (const login of ['agent', 'model', 'user', 'type']) {
      const req = { ...request(), model: 'model' };
      const events: HarnessEvent[] = [
        START,
        SAID(`agent:message from /home/${login}/x, -home-${login}-proj, 1 ${login} ${login} 12 a.md`),
      ];
      const raw = [{ type: 'user', message: { role: 'user', model: 'model' } }];
      const rec = join(tempDir(), 'rec');
      const result = await recordingHarness(standIn({ events, raw }), {
        dir: rec,
        secrets: [],
        roots: {},
        names: { $USER: login },
      }).run(req);
      expect(result.outcome).toBe('done');
      const recorded = read(rec, 'spec#1').tries[0];
      expect(recorded?.request.model).toBe('model');
      expect(recorded?.events.map((event) => event.type)).toEqual(['harness:session_start', 'agent:message']);
      expect(recorded?.events[1]).toEqual(
        SAID('agent:message from /home/$USER/x, -home-$USER-proj, 1 $USER $USER 12 a.md'),
      );
      expect(recorded?.raw).toEqual(raw);
    }
  });

  test('a temp path and a machine path outside every root keep only their last segment, and portable paths stay', () => {
    const top = ['Applications', 'dev', 'etc', 'opt', 'private', 'tmp', 'Users', 'usr', 'var'];
    const mask = maskPaths({ $WORKSPACE: '/w/x' }, {}, top);
    expect(
      mask({
        reason: 'write /tmp/commit-msg-1.txt → /private/tmp/commit-msg-1.txt: outside the workspace and $STAGE_OUT',
        messaging_socket_path: '/tmp/cc-socks/87516.sock',
        temps:
          '/var/folders/ab/cd12_x/T/x.txt, /private/var/folders/ab/cd12_x/C/y, /var/folders/ab/cd12_x, /tmp, /tmp/',
        trace:
          'stack: /Applications/Xcode-26.4.0.app/Contents/Developer/usr/bin/git\n14:14 dir: /Applications/Xcode-26.4.0.app/Contents/Developer/usr/bin',
        json: '{"bun":"/opt/homebrew/bin/bun","log":"a\\n/opt/tool/x","home":"/Users/someone/notes.md"}',
        kept: 'x 2>/dev/null; #!/usr/bin/env bun; /etc/hosts; </untrusted-input>; $STAGE_IN/tickets/FAKE-1; /tickets/FAKE-1; src/tmp/a; https://example.com/tmp/a; /Applications; /w/x/tmp/a',
      }),
    ).toEqual({
      reason: 'write $TMP/commit-msg-1.txt → $TMP/commit-msg-1.txt: outside the workspace and $STAGE_OUT',
      messaging_socket_path: '$TMP/87516.sock',
      temps: '$TMP/x.txt, $TMP/y, $TMP, $TMP, $TMP/',
      trace: 'stack: $MACHINE/git\n14:14 dir: $MACHINE/bin',
      json: '{"bun":"$MACHINE/bun","log":"a\\n$MACHINE/x","home":"$MACHINE/notes.md"}',
      kept: 'x 2>/dev/null; #!/usr/bin/env bun; /etc/hosts; </untrusted-input>; $STAGE_IN/tickets/FAKE-1; /tickets/FAKE-1; src/tmp/a; https://example.com/tmp/a; /Applications; $WORKSPACE/tmp/a',
    });
  });

  test('a recording holds no system temp path: not in an event, a raw message, nor a produced file (live run)', async () => {
    const req = request();
    const events: HarnessEvent[] = [
      START,
      SAID('write /tmp/commit-msg-1.txt → /private/tmp/commit-msg-1.txt: outside the workspace and $STAGE_OUT'),
    ];
    const raw = [{ type: 'system', messaging_socket_path: '/tmp/cc-socks/87516.sock' }];
    const files = { 'notes.md': 'scratch in /private/var/folders/ab/cd12_x/T/n.txt and /tmp/m.txt\n' };
    const { dir, harness } = recorder(standIn({ events, raw, files }));
    await harness.run(req);
    const recorded = read(dir, 'spec#1').tries[0];
    expect(recorded?.events[1]).toEqual(
      SAID('write $TMP/commit-msg-1.txt → $TMP/commit-msg-1.txt: outside the workspace and $STAGE_OUT'),
    );
    expect(recorded?.raw).toEqual([{ type: 'system', messaging_socket_path: '$TMP/87516.sock' }]);
    expect(recorded?.files['notes.md']).toEqual({
      encoding: 'utf8',
      content: 'scratch in $TMP/n.txt and $TMP/m.txt\n',
    });
    for (const form of ['/tmp/', '/private/', '/var/folders', 'cc-socks']) expect(bytes(dir)).not.toContain(form);
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

  test('a file in STAGE_OUT that cannot be read before the session is an error result, not a rejection (review #1.14)', async () => {
    const req = request();
    const locked = join(req.env.STAGE_OUT ?? '', 'locked.md');
    writeFileSync(locked, 'x');
    chmodSync(locked, 0o000);
    let ran = false;
    const { harness } = recorder({
      ...standIn(),
      run: async (r) => {
        ran = true;
        return standIn().run(r);
      },
    });
    try {
      const result = await harness.run(req);
      expect(result).toMatchObject({ outcome: 'error', reason: 'harness' });
      expect(result.outcome === 'error' && result.message).toContain('recording: ');
      expect(ran).toBe(false);
    } finally {
      chmodSync(locked, 0o644);
    }
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
