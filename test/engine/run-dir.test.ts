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
  copiedIntakeFile,
  copyStageFolders,
  createRunDir,
  RUNS_DIR,
  type RunStatus,
  readStatus,
  runsDir,
  STOP_REASONS,
  type Status,
  type StopReason,
  writeStatus,
} from '../../src/engine/run-dir';
import { newRunId } from '../../src/engine/run-id';
import { syncedDirs } from '../helpers/synced-dirs';

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

test('createRunDir creates .sail-runs/ on first use, then the run directory, once', () => {
  const root = tempDir();
  const sailDir = join(root, '.sail');
  mkdirSync(sailDir);
  const runId = newRunId('FAKE-1');
  expect(runId).toMatch(/^FAKE-1-[0-9A-Z]{26}$/);

  const dir = createRunDir(sailDir, runId);
  expect(dir).toBe(join(root, '.sail-runs', runId));
  expect(statSync(dir).isDirectory()).toBe(true);
  expect(readdirSync(dir)).toEqual([]);
  expect(() => createRunDir(sailDir, runId)).toThrow(expect.objectContaining({ code: 'EEXIST' }));

  const second = createRunDir(sailDir, newRunId('FAKE-1'));
  expect(readdirSync(join(root, '.sail-runs'))).toHaveLength(2);
  expect(existsSync(second)).toBe(true);
});

test('createRunDir syncs the directory holding .sail-runs/, so a crash cannot lose the first run whole', () => {
  const root = tempDir();
  const sailDir = join(root, '.sail');
  mkdirSync(sailDir);
  const runs = join(root, '.sail-runs');
  expect(syncedDirs(() => createRunDir(sailDir, newRunId('FAKE-1')))).toEqual([root, runs]);
  expect(syncedDirs(() => createRunDir(sailDir, newRunId('FAKE-1')))).toEqual([root, runs]);
});

const PAIRINGS: RunStatus[] = [
  { status: 'running' },
  { status: 'completed' },
  ...STOP_REASONS.flatMap((stopReason): RunStatus[] => [
    { status: 'failed', stopReason },
    { status: 'suspended', stopReason },
  ]),
];

test.each(PAIRINGS)('STATUS round-trips %o', ({ status, stopReason }) => {
  const dir = tempDir();
  writeStatus(dir, 'running');
  writeStatus(dir, status, stopReason);
  const line = stopReason === undefined ? status : `${status} ${stopReason}`;
  expect(readFileSync(join(dir, 'STATUS'), 'utf8')).toBe(`${line}\n`);
  expect(readStatus(dir)).toEqual(stopReason === undefined ? { status } : { status, stopReason });
  expect(readdirSync(dir)).toEqual(['STATUS']);
});

test.each<[Status, StopReason | undefined, string]>([
  ['failed', undefined, 'a failed run carries exactly one stop reason'],
  ['suspended', undefined, 'a suspended run carries exactly one stop reason'],
  ['completed', 'stage_error', 'a completed run carries no stop reason'],
  ['running', 'workflow_failed', 'a running run carries no stop reason'],
])('writeStatus refuses %s with stop reason %p, and STATUS keeps its content', (status, stopReason, message) => {
  const dir = tempDir();
  writeStatus(dir, 'running');
  expect(() => writeStatus(dir, status, stopReason)).toThrow(message);
  expect(readFileSync(join(dir, 'STATUS'), 'utf8')).toBe('running\n');
  expect(readdirSync(dir)).toEqual(['STATUS']);
});

test.each([
  ['bogus\n'],
  ['running'],
  [''],
  ['failed\n'],
  ['completed workflow_failed\n'],
  ['failed bogus\n'],
  ['failed workflow_failed'],
  ['failed  workflow_failed\n'],
  ['failed workflow_failed stage_error\n'],
])('readStatus refuses %p, naming the file', (text) => {
  const dir = tempDir();
  writeFileSync(join(dir, 'STATUS'), text);
  expect(() => readStatus(dir)).toThrow(`${join(dir, 'STATUS')} holds ${JSON.stringify(text)}`);
});

test("the golden run's STATUS reads completed", () => {
  expect(readStatus(GOLDEN)).toEqual({ status: 'completed' });
});

test('port_unavailable is the last stop reason, so STATUS can say a suspended run ended on an unavailable port', () => {
  expect(STOP_REASONS.join(' ')).toBe(
    'workflow_failed stage_error budget_exceeded determinism_violation until unwatched stopped interrupted usage_limit port_unavailable',
  );
});

test("the stop reasons are sail.summary.v1's, in its order", () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'schemas', 'sail.summary.v1.json'), 'utf8'));
  expect([...STOP_REASONS]).toEqual(schema.properties.stopReason.enum);
});

function repoWith(files: string[]): string {
  const root = tempDir();
  for (const file of files) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), file);
  }
  return root;
}

const stageEntry = { origin: 'repo:.sail/stages/echo' };

test("copyStageFolders copies a private intake's workflow folder and a shared intake's folder into the definition", () => {
  const root = repoWith([
    '.sail/workflows/groom/intake.ts',
    '.sail/workflows/groom/fetch.sh',
    '.sail/intakes/shared/intake.ts',
    '.sail/intakes/shared/fetch.sh',
    '.sail/stages/echo/stage.ts',
  ]);
  for (const origin of ['repo:.sail/workflows/groom/intake.ts', 'repo:.sail/intakes/shared']) {
    const runDir = tempDir();
    copyStageFolders(runDir, root, { intake: { name: 'groom', origin }, stages: { echo: stageEntry } });
    const copied = (path: string) => existsSync(join(runDir, 'definition', path));
    expect(copied('.sail/stages/echo/stage.ts')).toBe(true);
    const folder = origin.endsWith('.ts') ? '.sail/workflows/groom' : '.sail/intakes/shared';
    expect(copied(`${folder}/fetch.sh`)).toBe(true);
  }
});

test('copyStageFolders copies no folder for a built-in intake', () => {
  const root = repoWith(['.sail/stages/echo/stage.ts']);
  const runDir = tempDir();
  copyStageFolders(runDir, root, { intake: { name: 'ticket', origin: 'builtin' }, stages: { echo: stageEntry } });
  expect(readdirSync(join(runDir, 'definition', '.sail'))).toEqual(['stages']);
});

test("copiedIntakeFile is a file beside the run's copy of the intake's folder, or the live file when the run has no copy", () => {
  const root = repoWith(['.sail/workflows/groom/intake.ts', '.sail/intakes/shared/intake.ts']);
  const runDir = tempDir();
  const live = join(root, '.sail/workflows/groom/intake.ts');
  expect(copiedIntakeFile(runDir, 'repo:.sail/workflows/groom/intake.ts', live)).toBe(live);
  copyStageFolders(runDir, root, {
    intake: { name: 'groom', origin: 'repo:.sail/workflows/groom/intake.ts' },
    stages: {},
  });
  expect(copiedIntakeFile(runDir, 'repo:.sail/workflows/groom/intake.ts', live)).toBe(
    join(runDir, 'definition', '.sail/workflows/groom/intake.ts'),
  );
  const shared = join(root, '.sail/intakes/shared/intake.ts');
  expect(copiedIntakeFile(runDir, 'repo:.sail/intakes/shared', shared)).toBe(shared);
  copyStageFolders(runDir, root, { intake: { name: 'shared', origin: 'repo:.sail/intakes/shared' }, stages: {} });
  expect(copiedIntakeFile(runDir, 'repo:.sail/intakes/shared', shared)).toBe(
    join(runDir, 'definition', '.sail/intakes/shared/intake.ts'),
  );
  expect(copiedIntakeFile(runDir, 'builtin', live)).toBe(live);
});
