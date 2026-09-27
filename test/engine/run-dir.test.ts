import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRunDir,
  LOCAL_SOURCE,
  RUNS_DIR,
  readStatus,
  runsDir,
  type Status,
  writeStatus,
} from '../../src/engine/run-dir';
import { newRunId } from '../../src/engine/run-id';

const GOLDEN = join(import.meta.dir, '..', 'fixtures', 'runs', 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-run-dir-'));
  dirs.push(dir);
  return dir;
}

test('runs live in .sail-runs/, beside .sail/', () => {
  expect(RUNS_DIR).toBe('.sail-runs');
  expect(runsDir('/r/.sail')).toBe('/r/.sail-runs');
  expect(runsDir('/r/packages/app/.sail')).toBe('/r/packages/app/.sail-runs');
});

test('the LOCAL source stands in for a ticket until intake exists', () => {
  expect(LOCAL_SOURCE).toEqual({ kind: 'ticket', ticketKey: 'LOCAL', via: 'cli', forced: false });
});

test('createRunDir creates .sail-runs/ on first use, then the run directory, once', () => {
  const root = tempDir();
  const sailDir = join(root, '.sail');
  mkdirSync(sailDir);
  const runId = newRunId(LOCAL_SOURCE.ticketKey);
  expect(runId).toMatch(/^LOCAL-[0-9A-Z]{26}$/);

  const dir = createRunDir(sailDir, runId);
  expect(dir).toBe(join(root, '.sail-runs', runId));
  expect(statSync(dir).isDirectory()).toBe(true);
  expect(readdirSync(dir)).toEqual([]);
  expect(() => createRunDir(sailDir, runId)).toThrow(expect.objectContaining({ code: 'EEXIST' }));

  const second = createRunDir(sailDir, newRunId(LOCAL_SOURCE.ticketKey));
  expect(readdirSync(join(root, '.sail-runs'))).toHaveLength(2);
  expect(existsSync(second)).toBe(true);
});

test.each<Status>(['running', 'suspended', 'completed', 'failed'])('STATUS round-trips %s', (status) => {
  const dir = tempDir();
  writeStatus(dir, 'running');
  writeStatus(dir, status);
  expect(readFileSync(join(dir, 'STATUS'), 'utf8')).toBe(`${status}\n`);
  expect(readStatus(dir)).toBe(status);
  expect(readdirSync(dir)).toEqual(['STATUS']);
});

test.each([['bogus\n'], ['running'], ['']])('readStatus refuses %p, naming the file', (text) => {
  const dir = tempDir();
  writeFileSync(join(dir, 'STATUS'), text);
  expect(() => readStatus(dir)).toThrow(`${join(dir, 'STATUS')} holds ${JSON.stringify(text)}`);
});

test("the golden run's STATUS reads completed", () => {
  expect(readStatus(GOLDEN)).toBe('completed');
});
