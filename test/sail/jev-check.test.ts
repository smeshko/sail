// `.sail/lib/jev-check.mjs`'s own helpers, in this process: cutting a diff, running git, and asking Jev through a
// `sail` found on the PATH, here a stub that answers, fails or prints no JSON.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Asked {
  asked: boolean;
  model?: string;
  answers?: Record<string, unknown>;
  note?: string;
}
interface Lib {
  MAX_DIFF: number;
  cut(text: string): string;
  git(args: string[]): string;
  askNouls(questions: Record<string, unknown>, state: Record<string, unknown>, out: string): Asked;
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

test('askNouls answers nothing when sail fails, noting its last stderr line, or its exit code when it printed none', () => {
  const said = lib.askNouls({}, {}, stubSail('echo "first" >&2\necho "jev: no key" >&2\nexit 3'));
  const silent = lib.askNouls({}, {}, stubSail('exit 4'));
  expect({ said, silent }).toEqual({
    said: { asked: false, note: 'jev: no key' },
    silent: { asked: false, note: 'exited 4' },
  });
});

test('askNouls answers nothing when sail prints no JSON, or does not start', () => {
  const garbled = lib.askNouls({}, {}, stubSail('echo "not json"'));
  const out = stubSail('exit 0');
  process.env.PATH = out;
  rmSync(join(out, 'sail'));
  const missing = lib.askNouls({}, {}, out);
  expect({ garbled, missing: { asked: missing.asked, note: missing.note?.split(':')[0] } }).toEqual({
    garbled: { asked: false, note: 'sail port jev ask printed no JSON answer' },
    missing: { asked: false, note: 'sail port jev ask did not start' },
  });
});
