// `.sail/lib/jev-check.mjs`'s own helpers, in this process: cutting a diff, running git, and asking Jev through a
// `sail` found on the PATH, here a stub that answers, fails or prints no JSON.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Asked {
  asked: boolean;
  failed?: boolean;
  model?: string;
  answers?: Record<string, unknown>;
  note?: string;
}
interface Lib {
  MAX_DIFF: number;
  MAX_REQUEST_BYTES: number;
  TASKS_MAX_REQUEST_BYTES: number;
  cut(text: string): string;
  git(args: string[]): string;
  askNouls(
    questions: Record<string, unknown>,
    state: Record<string, unknown>,
    out: string,
    name?: string,
    limit?: number,
  ): Asked;
}
const ROOT = join(import.meta.dir, '..', '..');
const lib = (await import(join(ROOT, '.sail', 'lib', 'jev-check.mjs'))) as Lib;

const PATH = process.env.PATH;
const dirs: string[] = [];
afterEach(() => {
  process.env.PATH = PATH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory holding a `sail` that runs `body`, put first on the PATH, and the `out` directory askNouls writes to. */
function stubSail(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-test-jev-check-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'sail'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, 'sail'), 0o755);
  process.env.PATH = `${dir}:${PATH}`;
  return dir;
}

test('cut keeps a diff up to MAX_DIFF characters, and cuts a longer one with a marker naming what it left out', () => {
  const short = 'a'.repeat(lib.MAX_DIFF);
  const cut = lib.cut(`${short}bcd`);
  expect({ short: lib.cut(short) === short, cut }).toEqual({
    short: true,
    cut: `${short}\n… cut: 3 more characters`,
  });
});

test('git prints what git printed, and an empty text when git fails', () => {
  expect({ ok: lib.git(['--version']).startsWith('git version'), failed: lib.git(['no-such-command']) }).toEqual({
    ok: true,
    failed: '',
  });
});

test("askNouls writes the request beside the answers and reads the model and answers from sail's last line", () => {
  const out = stubSail(`echo "asking"\necho '{"model":"jev-1","answers":{"TASK-001":{"type":"noul","noul":0.97}}}'`);
  const asked = lib.askNouls({ 'TASK-001': { type: 'noul' } }, { commits: 'abc' }, out);
  expect({ asked, request: JSON.parse(readFileSync(join(out, 'jev-request.json'), 'utf8')) }).toEqual({
    asked: { asked: true, model: 'jev-1', answers: { 'TASK-001': { type: 'noul', noul: 0.97 } } },
    request: { state: { commits: 'abc' }, questions: { 'TASK-001': { type: 'noul' } } },
  });
});

test('askNouls does not send a request over MAX_REQUEST_BYTES, and notes its size', () => {
  const marker = join(tmpdir(), `sail-test-jev-check-marker-${process.pid}`);
  const out = stubSail(`touch ${marker}\necho '{"model":"jev-1","answers":{}}'`);
  dirs.push(marker);
  const state = { text: 'x'.repeat(lib.MAX_REQUEST_BYTES) };
  const bytes = Buffer.byteLength(JSON.stringify({ state, questions: {} }));
  const asked = lib.askNouls({}, state, out);
  expect({ asked, written: existsSync(join(out, 'jev-request.json')), sent: existsSync(marker) }).toEqual({
    asked: {
      asked: false,
      note: `the request is ${bytes} bytes, over the ${lib.MAX_REQUEST_BYTES}-byte limit Jev accepts`,
    },
    written: true,
    sent: false,
  });
});

test('the limits are 64,000 bytes for every check and 76,000 for the tasks request', () => {
  expect([lib.MAX_REQUEST_BYTES, lib.TASKS_MAX_REQUEST_BYTES]).toEqual([64_000, 76_000]);
});

test('askNouls with a limit sends a request between 64,000 and 76,000 bytes, and refuses one over it naming that limit', () => {
  const out = stubSail(`echo '{"model":"jev-1","answers":{}}'`);
  const between = lib.askNouls({}, { text: 'x'.repeat(70_000) }, out, 'jev-request.json', 76_000);
  expect(between).toEqual({ asked: true, model: 'jev-1', answers: {} });
  const bytes = Buffer.byteLength(JSON.stringify({ state: { text: 'x'.repeat(80_000) }, questions: {} }));
  const over = lib.askNouls({}, { text: 'x'.repeat(80_000) }, out, 'jev-request.json', 76_000);
  expect(over).toEqual({
    asked: false,
    note: `the request is ${bytes} bytes, over the 76000-byte limit Jev accepts`,
  });
  expect(lib.askNouls({}, { text: 'x'.repeat(70_000) }, out).asked).toBe(false);
});

test('askNouls marks a request over MAX_REQUEST_BYTES, which it never sent, as not failed', () => {
  const out = stubSail('exit 1');
  const asked = lib.askNouls({}, { text: 'x'.repeat(lib.MAX_REQUEST_BYTES) }, out) as { failed?: boolean };
  expect(asked.failed).toBeUndefined();
});

test('askNouls answers nothing when sail fails, noting its last stderr line, or its exit code when it printed none', () => {
  const said = lib.askNouls({}, {}, stubSail('echo "first" >&2\necho "jev: no key" >&2\nexit 3'));
  const silent = lib.askNouls({}, {}, stubSail('exit 4'));
  expect({ said, silent }).toEqual({
    said: { asked: false, failed: true, note: 'jev: no key' },
    silent: { asked: false, failed: true, note: 'exited 4' },
  });
});

test('askNouls answers nothing when sail prints no JSON, or does not start', () => {
  const garbled = lib.askNouls({}, {}, stubSail('echo "not json"'));
  const out = stubSail('exit 0');
  process.env.PATH = out;
  rmSync(join(out, 'sail'));
  const missing = lib.askNouls({}, {}, out);
  expect({
    garbled,
    missing: { asked: missing.asked, failed: missing.failed, note: missing.note?.split(':')[0] },
  }).toEqual({
    garbled: { asked: false, failed: true, note: 'sail port jev ask printed no JSON answer' },
    missing: { asked: false, failed: true, note: 'sail port jev ask did not start' },
  });
});
