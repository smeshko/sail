import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copiedIntakeFile,
  copyDefinitions,
  createRunDir,
  RUNS_DIR,
  type RunStatus,
  readStatus,
  resumesFromCopy,
  runsDir,
  STOP_REASONS,
  type Status,
  type StopReason,
  uncopiedRefusal,
  unmarkedRefusal,
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

test('copyDefinitions copies the whole .sail/ at its path from the root, a stage folder and a lib file alike', () => {
  const root = repoWith([
    '.sail/project.yaml',
    '.sail/stages/echo/stage.ts',
    '.sail/lib/util.ts',
    '.sail/workflows/w/workflow.ts',
  ]);
  const runDir = tempDir();
  copyDefinitions(runDir, root, join(root, '.sail'), []);
  const copied = (path: string) => readFileSync(join(runDir, 'definition', path), 'utf8');
  expect(copied('.sail/project.yaml')).toBe('.sail/project.yaml');
  expect(copied('.sail/stages/echo/stage.ts')).toBe('.sail/stages/echo/stage.ts');
  expect(copied('.sail/lib/util.ts')).toBe('.sail/lib/util.ts');
  expect(copied('.sail/workflows/w/workflow.ts')).toBe('.sail/workflows/w/workflow.ts');
});

test('copyDefinitions leaves out every node_modules under .sail/', () => {
  const root = repoWith([
    '.sail/stages/echo/stage.ts',
    '.sail/node_modules/a/index.js',
    '.sail/stages/echo/node_modules/b/index.js',
  ]);
  const runDir = tempDir();
  copyDefinitions(runDir, root, join(root, '.sail'), []);
  expect(existsSync(join(runDir, 'definition', '.sail/stages/echo/stage.ts'))).toBe(true);
  expect(existsSync(join(runDir, 'definition', '.sail/node_modules'))).toBe(false);
  expect(existsSync(join(runDir, 'definition', '.sail/stages/echo/node_modules'))).toBe(false);
});

test('copyDefinitions copies a convention at its path, and skips one the root lacks', () => {
  const root = repoWith(['.sail/project.yaml', 'AGENTS.md', 'docs/rules.md']);
  const runDir = tempDir();
  copyDefinitions(runDir, root, join(root, '.sail'), ['AGENTS.md', 'CLAUDE.md', 'docs/rules.md']);
  expect(readFileSync(join(runDir, 'definition', 'AGENTS.md'), 'utf8')).toBe('AGENTS.md');
  expect(readFileSync(join(runDir, 'definition', 'docs/rules.md'), 'utf8')).toBe('docs/rules.md');
  expect(existsSync(join(runDir, 'definition', 'CLAUDE.md'))).toBe(false);
});

test('copyDefinitions copies a symlink verbatim instead of following it', () => {
  const root = repoWith(['.sail/project.yaml', '.sail/real/file.txt']);
  symlinkSync('real', join(root, '.sail/alias'));
  const runDir = tempDir();
  copyDefinitions(runDir, root, join(root, '.sail'), []);
  expect(readlinkSync(join(runDir, 'definition', '.sail/alias'))).toBe('real');
});

test("copyDefinitions copies a convention that is a symlink as its target's content, which the copy can't reach", () => {
  const root = repoWith(['.sail/project.yaml', 'AGENTS.md', 'docs/agents.md']);
  symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
  rmSync(join(root, 'AGENTS.md'));
  symlinkSync('docs/agents.md', join(root, 'AGENTS.md'));
  const runDir = tempDir();
  copyDefinitions(runDir, root, join(root, '.sail'), ['CLAUDE.md']);
  expect(readFileSync(join(runDir, 'definition', 'CLAUDE.md'), 'utf8')).toBe('docs/agents.md');
  expect(existsSync(join(runDir, 'definition', 'docs/agents.md'))).toBe(false);
});

test('a run resumes from its own copy with layout 3, or with a definitionsSha, and not as a layout-2 hand start', () => {
  expect(resumesFromCopy({ layout: 3 })).toBe(true);
  expect(resumesFromCopy({ layout: 2, definitionsSha: 'abc' })).toBe(true);
  expect(resumesFromCopy({ layout: 2 })).toBe(false);
});

test('unmarkedRefusal refuses only a header with no layout, and uncopiedRefusal only a layout-2 header with no definitionsSha', () => {
  expect(unmarkedRefusal('R', {}, 'be resumed')).toContain("run R keeps its calls' records inside their $STAGE_OUT");
  expect(unmarkedRefusal('R', { layout: 2 }, 'seed a run')).toBeUndefined();
  expect(unmarkedRefusal('R', { layout: 3 }, 'be resumed')).toBeUndefined();
  expect(uncopiedRefusal('R', { layout: 3 })).toBeUndefined();
  expect(uncopiedRefusal('R', { layout: 2, definitionsSha: 'abc' })).toBeUndefined();
  expect(uncopiedRefusal('R', { layout: 2 })).toBe(
    "run R started before runs kept their whole .sail/ in definition/: it can't be resumed. sail stop R ends it, and sail run --from-run R --stage <stage> --continue restarts it",
  );
});

test("copiedIntakeFile is a file beside the run's copy of the intake's folder, or the live file when the run has no copy", () => {
  const root = repoWith(['.sail/workflows/groom/intake.ts', '.sail/intakes/shared/intake.ts']);
  const runDir = tempDir();
  const live = join(root, '.sail/workflows/groom/intake.ts');
  expect(copiedIntakeFile(runDir, 'repo:.sail/workflows/groom/intake.ts', live)).toBe(live);
  copyDefinitions(runDir, root, join(root, '.sail'), []);
  expect(copiedIntakeFile(runDir, 'repo:.sail/workflows/groom/intake.ts', live)).toBe(
    join(runDir, 'definition', '.sail/workflows/groom/intake.ts'),
  );
  const shared = join(root, '.sail/intakes/shared/intake.ts');
  expect(copiedIntakeFile(tempDir(), 'repo:.sail/intakes/shared', shared)).toBe(shared);
  expect(copiedIntakeFile(runDir, 'repo:.sail/intakes/shared', shared)).toBe(
    join(runDir, 'definition', '.sail/intakes/shared/intake.ts'),
  );
  expect(copiedIntakeFile(runDir, 'builtin', live)).toBe(live);
});
