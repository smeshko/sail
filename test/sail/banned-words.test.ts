import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nouls, writeOwnSail } from '../helpers/own-sail';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

interface Entry {
  term: string;
  definition: string;
  avoid: string[];
  avoidText?: string;
}
interface Line {
  file: string;
  line: number;
  text: string;
  context: { line: number; text: string }[];
}
interface Candidate extends Line, Entry {
  word: string;
}
interface Lib {
  BANNED_YES: number;
  parseGlossary(text: string): Entry[];
  bannedLines(diff: string): Line[];
  bannedCandidates(lines: Line[], glossary: Entry[]): Candidate[];
  bannedPattern(word: string): RegExp;
  bannedMatches(pattern: RegExp, text: string): boolean;
  bannedState(candidates: Candidate[], start?: number): unknown;
  BANNED_REFERS: number;
  BANNED_CONCURRENCY: number;
  JS_KEYWORDS: Set<string>;
  bannedHits(
    asked: Candidate[],
    answers: Record<string, unknown>,
  ): { file: string; line: number; word: string; term: string; yes: number }[];
  bannedRemoved(diff: string): Set<string>;
  bannedSelect(
    candidates: Candidate[],
    removed?: Set<string>,
  ): { selected: Candidate[]; keyword: number; moved: number; repeat: number };
  bannedRequests(candidates: Candidate[]): {
    requests: { candidates: Candidate[]; state: unknown; questions: Record<string, unknown> }[];
    asked: Candidate[];
    oversized: number;
  };
  bannedQuestions(candidates: Candidate[], start?: number): Record<string, { type: string; instructions: string }>;
  bannedAsk<R, A extends { asked?: boolean; failed?: boolean; note?: string; answers?: Record<string, unknown> }>(
    requests: R[],
    ask: (request: R, i: number) => Promise<A>,
    options?: { deadlineMs?: number; now?: () => number; concurrency?: number },
  ): Promise<{ results: A[]; unasked: number; reason: string }>;
}
const lib = (await import(join(import.meta.dir, '../../.sail/lib/jev-check.mjs'))) as Lib;
const entry = { term: 'Call', definition: 'One invocation.', avoid: ['invocation'] };
const glossary = '**Call**:\nOne invocation.\n_Avoid_: invocation\n';
const doc = '+++ b/note.md\n@@ -0,0 +1 @@\n+Each invocation of a stage\n';
function stage(repo: TempRepo, diff: string, base = repo.git('rev-parse', 'HEAD').trim(), first = '') {
  const out = join(repo.home, 'out');
  mkdirSync(out);
  const patch = join(repo.home, 'diff');
  writeFileSync(patch, diff);
  const baseFile = join(repo.home, 'base.txt');
  writeFileSync(baseFile, `${base}\n`);
  const child = Bun.spawnSync([join(repo.dir, '.sail/workflows/review/stages/02-banned-words/run.sh')], {
    cwd: repo.dir,
    env: {
      ...repo.env,
      PATH: `${first ? `${first}:` : ''}${join(import.meta.dir, '../../bin')}:${repo.env.PATH}`,
      SAIL_BUN: process.execPath,
      SAIL_CONFIG: join(repo.dir, '.sail/project.yaml'),
      SAIL_HOME: repo.home,
      STAGE_OUT: out,
      INPUT_DIFF: patch,
      INPUT_BASE: baseFile,
    },
  });
  return {
    code: child.exitCode,
    stderr: child.stderr.toString(),
    output: JSON.parse(child.stdout.toString()),
    request: join(out, 'jev-request.json'),
  };
}
function setup(repo: TempRepo, answers?: Record<string, number>) {
  writeOwnSail(repo, answers === undefined ? {} : { jev: nouls(answers) });
  writeFileSync(join(repo.dir, 'CONTEXT.md'), glossary);
}
test('the stage, with Jev answering word-1 0.97, reports the hit with its word and term', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.97 });
    const result = stage(repo, doc);
    expect(result.code).toBe(0);
    expect(result.output).toEqual({
      hits: [{ file: 'note.md', line: 1, word: 'invocation', term: 'Call', yes: 0.97 }],
      glossary: { entries: 1, words: 1 },
      jev: {
        asked: true,
        failed: false,
        note: '',
        threshold: 0.8,
        candidates: 1,
        requests: 1,
        skipped: { keyword: 0, moved: 0, repeat: 0, oversized: 0 },
      },
    });
  });
});
test('the stage reports no hit for an allowed shell invocation when Jev answers 0.05', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.05 });
    const result = stage(repo, '+++ b/note.md\n@@ -0,0 +1 @@\n+A shell invocation runs the command.\n');
    expect(result.output.hits).toEqual([]);
    expect(result.output.jev.asked).toBe(true);
    expect(JSON.parse(readFileSync(result.request, 'utf8')).state.lines['line-1'].text).toBe(
      'A shell invocation runs the command.',
    );
  });
});
/** The question names of each of the first `n` request files in `out`. */
function requestQuestions(out: string, n: number) {
  return Array.from({ length: n }, (_, i) =>
    Object.keys(
      JSON.parse(readFileSync(join(out, i === 0 ? 'jev-request.json' : `jev-request-${i + 1}.json`), 'utf8')).questions,
    ),
  );
}
test('the stage asks six candidates in six requests of their own, each with a second noul', async () => {
  await withTempRepo((repo) => {
    setup(repo, Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`word-${i + 1}`, i === 4 ? 0.97 : 0.05])));
    const files = Array.from({ length: 6 }, (_, i) => `+++ b/f${i + 1}.md\n@@ -0,0 +1 @@\n+invocation\n`).join('');
    const result = stage(repo, files);
    const out = join(repo.home, 'out');
    expect(existsSync(join(out, 'jev-request-7.json'))).toBe(false);
    for (let n = 1; n <= 6; n++) {
      const request = JSON.parse(
        readFileSync(join(out, n === 1 ? 'jev-request.json' : `jev-request-${n}.json`), 'utf8'),
      );
      expect(Object.keys(request.questions)).toEqual([`word-${n}`, `word-${n}:refers`]);
      expect(Object.keys(request.state.entries)).toEqual(['Call']);
      expect(Object.keys(request.state.lines)).toEqual(['line-1']);
      expect(request.state.lines['line-1'].file).toBe(`f${n}.md`);
      expect(Object.keys(request.state.candidates)).toEqual([`word-${n}`]);
    }
    expect(result.output.jev).toEqual({
      asked: true,
      failed: false,
      note: '',
      threshold: 0.8,
      candidates: 6,
      requests: 6,
      skipped: { keyword: 0, moved: 0, repeat: 0, oversized: 0 },
    });
    expect(result.output.hits).toEqual([{ file: 'f5.md', line: 1, word: 'invocation', term: 'Call', yes: 0.97 }]);
  });
}, 120_000);
test('the stage flags no line whose word Jev does not read as referring to the entry', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.97, 'word-1:refers': 0.2 });
    expect(stage(repo, doc).output.hits).toEqual([]);
  });
});
test('Jev state includes a repeated definition and line context only once', () => {
  const candidates = lib.bannedCandidates(
    [{ ...line, text: 'invocation execution' }],
    [{ ...entry, avoid: ['invocation', 'execution'] }],
  );
  const state = JSON.stringify(lib.bannedState(candidates));
  expect(state.split(entry.definition).length - 1).toBe(1);
  expect(state.split('invocation execution').length - 1).toBe(1);
});
test('a single oversized candidate makes no Jev request and reports the omission', async () => {
  await withTempRepo((repo) => {
    setup(repo, {});
    const result = stage(repo, `+++ b/note.md\n@@ -0,0 +1 @@\n+invocation ${'x'.repeat(100_000)}\n`);
    expect(existsSync(result.request)).toBe(false);
    expect(result.output.jev.asked).toBe(false);
    expect(result.output.jev.note).toContain('1 candidates omitted');
    expect(result.output.jev.requests).toBe(0);
    expect(result.output.jev.skipped.oversized).toBe(1);
  });
});

test('the stage asks Jev nothing when no added line holds an avoided word', async () => {
  await withTempRepo((repo) => {
    setup(repo, {});
    const result = stage(repo, '+++ b/x.ts\n@@ -0,0 +1 @@\n+const x = 1;\n');
    expect(result.output.jev).toEqual({
      asked: false,
      failed: false,
      note: 'no avoided word on an added line',
      threshold: 0.8,
      candidates: 0,
      requests: 0,
      skipped: { keyword: 0, moved: 0, repeat: 0, oversized: 0 },
    });
    expect(existsSync(result.request)).toBe(false);
  });
});
test('the stage makes no candidate of a commit message and asks Jev nothing', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.97 });
    const base = repo.git('rev-parse', 'HEAD').trim();
    repo.git('commit', '--allow-empty', '-m', 'invocation');
    const result = stage(repo, '', base);
    expect(result.output.hits).toEqual([]);
    expect(result.output.jev).toMatchObject({ candidates: 0, asked: false });
    expect(existsSync(result.request)).toBe(false);
  });
});
test('the stage, with a Jev answering 402, exits 0 and reports the port failure with the credits message', async () => {
  await withTempRepo((repo) => {
    writeOwnSail(repo, { jev: { error: { status: 402, detail: 'billing_error' } } });
    writeFileSync(join(repo.dir, 'CONTEXT.md'), glossary);
    const result = stage(repo, doc);
    expect(result.code).toBe(0);
    expect(result.output.hits).toEqual([]);
    expect(result.output.jev).toMatchObject({ asked: false, failed: true, candidates: 1 });
    expect(result.output.jev.note).toContain('the TypeSafe account has no credits');
  });
});
test('the stage exits zero without adapters.jev even when there are candidates', async () => {
  await withTempRepo((repo) => {
    setup(repo);
    const result = stage(repo, doc);
    expect(result.code).toBe(0);
    expect(result.output.hits).toEqual([]);
    expect(result.output.jev.asked).toBe(false);
    expect(result.output.jev.candidates).toBe(1);
  });
});
test('the Jev request holds the glossary entry, added line and its context', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.97 });
    const result = stage(repo, '+++ b/a.ts\n@@ -1 +1,2 @@\n before\n+invocation\n');
    expect(existsSync(result.request)).toBe(true);
    expect(JSON.parse(readFileSync(result.request, 'utf8')).state).toEqual({
      entries: { Call: { ...entry, avoidText: 'invocation' } },
      lines: {
        'line-1': {
          file: 'a.ts',
          line: 2,
          text: 'invocation',
          context: [{ line: 1, text: 'before' }],
        },
      },
      candidates: { 'word-1': { word: 'invocation', entry: 'Call', location: 'line-1' } },
    });
  });
});
test('the stage includes answers exactly at the threshold but excludes answers just below it', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.8, 'word-2': 0.799 });
    const result = stage(repo, `${doc}+++ b/other.md\n@@ -0,0 +1 @@\n+invocation\n`);
    expect(result.output.hits).toEqual([{ file: 'note.md', line: 1, word: 'invocation', term: 'Call', yes: 0.8 }]);
    expect(result.output.jev.candidates).toBe(2);
  });
});
test('the stage with no CONTEXT.md makes no Jev request', async () => {
  await withTempRepo((repo) => {
    setup(repo, {});
    unlinkSync(join(repo.dir, 'CONTEXT.md'));
    const result = stage(repo, doc);
    expect(result.output.jev).toEqual({
      asked: false,
      failed: false,
      note: 'no CONTEXT.md',
      threshold: 0.8,
      candidates: 0,
      requests: 0,
      skipped: { keyword: 0, moved: 0, repeat: 0, oversized: 0 },
    });
    expect(result.output.glossary).toEqual({ entries: 0, words: 0 });
    expect(existsSync(result.request)).toBe(false);
  });
});
test('the stage with no glossary entries makes no Jev request', async () => {
  await withTempRepo((repo) => {
    setup(repo, {});
    writeFileSync(join(repo.dir, 'CONTEXT.md'), '# Glossary\n');
    const result = stage(repo, doc);
    expect(result.output.glossary).toEqual({ entries: 0, words: 0 });
    expect(result.output.jev).toEqual({
      asked: false,
      failed: false,
      note: 'no avoided word on an added line',
      threshold: 0.8,
      candidates: 0,
      requests: 0,
      skipped: { keyword: 0, moved: 0, repeat: 0, oversized: 0 },
    });
    expect(existsSync(result.request)).toBe(false);
  });
});
const line = { file: 'a.ts', line: 4, text: 'Invocation', context: [] };

test('parseGlossary reads terms, definitions and Avoid words, skipping prose', () => {
  expect(
    lib.parseGlossary(`**Call**:
One invocation.
_Avoid_: attempt, execution, stage run, invocation
**Watcher registry**:
The record.
_Avoid_: registry (alone; the config also has an adapter registry), roster, manifest
**Loop**:
A repetition.
_Avoid_: cycle, retry loop, while; and "loop" for a watched workflow
**System One**:
The API.
_Avoid_: using it for the Jev port or its adapter
**Outcome**:
How it ended:
- passed
- failed
_Avoid_: status, status
**Missing**:
No avoid line.
`),
  ).toEqual([
    {
      term: 'Call',
      definition: 'One invocation.',
      avoid: ['attempt', 'execution', 'stage run', 'invocation'],
      avoidText: 'attempt, execution, stage run, invocation',
    },
    {
      term: 'Watcher registry',
      definition: 'The record.',
      avoid: ['registry', 'roster', 'manifest'],
      avoidText: 'registry (alone; the config also has an adapter registry), roster, manifest',
    },
    {
      term: 'Loop',
      definition: 'A repetition.',
      avoid: ['cycle', 'retry loop', 'while', 'loop'],
      avoidText: 'cycle, retry loop, while; and "loop" for a watched workflow',
    },
    {
      term: 'System One',
      definition: 'The API.',
      avoid: [],
      avoidText: 'using it for the Jev port or its adapter',
    },
    {
      term: 'Outcome',
      definition: 'How it ended:\n- passed\n- failed',
      avoid: ['status'],
      avoidText: 'status, status',
    },
  ]);
});
test('parseGlossary reads real Call and Branch entries without long prose words', () => {
  const entries = lib.parseGlossary(readFileSync(join(import.meta.dir, '../../CONTEXT.md'), 'utf8'));
  expect(entries.find((e) => e.term === 'Call')?.avoid).toEqual(['attempt', 'execution', 'stage run', 'invocation']);
  expect(entries.find((e) => e.term === 'Branch')?.avoid).toEqual(['branch']);
  expect(entries.flatMap((e) => e.avoid).filter((word) => word.split(/\s+/).length > 3)).toEqual([]);
});
test('a real definition written one sentence per line is one entry, and none of its lines passes 1,000 characters', () => {
  const text = readFileSync(join(import.meta.dir, '../../CONTEXT.md'), 'utf8');
  const entries = lib.parseGlossary(text);
  expect(entries.length).toBe(text.split('\n').filter((row) => /^\*\*(.+?)\*\*:\s*$/.test(row)).length);
  const dashboard = entries.find((e) => e.term === 'Dashboard')?.definition.split('\n') ?? [];
  expect(dashboard.length).toBeGreaterThan(10);
  expect(dashboard.filter((row) => row === '')).toEqual([]);
  const long = entries.flatMap((e) =>
    e.definition
      .split('\n')
      .filter((row) => row.length > 1000)
      .map(() => e.term),
  );
  expect(long).toEqual([]);
});
test('Jev receives the full Avoid wording, including sense qualifiers', () => {
  const glossary = lib.parseGlossary('**Call**:\nOne invocation.\n_Avoid_: invocation (as a noun), execution\n');
  const candidates = lib.bannedCandidates([line], glossary);
  expect(candidates.map((candidate) => candidate.word)).toEqual(['invocation']);
  expect(JSON.stringify(lib.bannedState(candidates))).toContain('invocation (as a noun), execution');
});

test('bannedCandidates matches an avoided word as a camelCase part, a kebab part and a plural', () => {
  const glossary = [
    { term: 'T', definition: 'D.', avoid: ['nav', 'notice', 'ADW', 'loop', 'retry loop', 'a.b', 'stage run'] },
  ];
  const words = (text: string) => lib.bannedCandidates([{ ...line, text }], glossary).map((c) => c.word);
  for (const text of ['navCounts', 'sideNav', 'side-nav', 'NAV', 'navs']) expect(words(text)).toContain('nav');
  expect(words('notices')).toEqual(['notice']);
  expect(words('run-loop')).toEqual(['loop']);
  for (const text of ['retry  loop', 'retry-loop', 'retryLoop']) expect(words(text)).toContain('retry loop');
  expect(words('stageRun')).toEqual(['stage run']);
  expect(words('a.b')).toEqual(['a.b']);
  expect(words('axb')).toEqual([]);
  for (const text of ['ADW-387', 'navigate', 'canvas', 'nav_counts', 'noticed']) expect(words(text)).toEqual([]);
});
test('bannedCandidates matches an avoided word inside an UPPER_SNAKE identifier only', () => {
  const glossary = [
    { term: 'T', definition: 'D.', avoid: ['nav', 'lock', 'stage run'] },
    { term: 'Kind', definition: 'D.', avoid: ['type'] },
  ];
  const words = (text: string) => lib.bannedCandidates([{ ...line, text }], glossary).map((c) => c.word);
  expect(words('SAIL_GATE_LOCK_HOLDER')).toEqual(['lock']);
  expect(words('NAV_COUNTS')).toEqual(['nav']);
  expect(words('STAGE_RUN')).toEqual(['stage run']);
  expect(words('LOCKS_HELD')).toEqual(['lock']);
  for (const text of ['nav_counts', 'Nav_Counts', 'GATE_LOCKED', 'BLOCK_SIZE']) expect(words(text)).toEqual([]);
  const selected = lib.bannedSelect(
    lib.bannedCandidates([{ file: 'a.ts', line: 1, text: 'const STEP_TYPE = 1;', context: [] }], glossary),
  );
  expect(selected).toMatchObject({ keyword: 0 });
  expect(selected.selected).toHaveLength(1);
});
test('bannedCandidates keeps one candidate per word and entry, even for repeated words', () => {
  expect(
    lib
      .bannedCandidates([{ ...line, text: 'invocation invocation' }], [entry, { ...entry, term: 'Try' }])
      .map((c) => c.term),
  ).toEqual(['Call', 'Try']);
});
test('bannedLines skips glossary, generated and data paths and preserves new-side hunk neighbours', () => {
  const paths = [
    'CONTEXT.md',
    'a.json',
    'a.ndjson',
    'bun.lock',
    'types/a.ts',
    'test/fixtures/runs/a',
    'test/fixtures/terminal/a',
    'test/fixtures/dashboard/views/a',
  ];
  const skipped = paths.map((p) => `+++ b/${p}\n@@ -0,0 +1 @@\n+invocation\n`).join('');
  expect(lib.bannedLines(skipped)).toEqual([]);
  expect(
    lib.bannedLines(
      '+++ b/a.ts\n@@ -1,5 +1,5 @@\n before\n-old\n+Invocation\n after\n last\n end\n@@ -9 +9 @@\n+other\n',
    ),
  ).toEqual([
    {
      file: 'a.ts',
      line: 2,
      text: 'Invocation',
      context: [
        { line: 1, text: 'before' },
        { line: 3, text: 'after' },
        { line: 4, text: 'last' },
        { line: 5, text: 'end' },
      ],
    },
    { file: 'a.ts', line: 9, text: 'other', context: [] },
  ]);
});
test('bannedRequests makes a request of one candidate each, numbering word-n across them', () => {
  const small = { ...line, ...entry, word: 'invocation' };
  const result = lib.bannedRequests([small, small, small]);
  expect(result.requests.map((r) => r.candidates.length)).toEqual([1, 1, 1]);
  expect(Object.keys(result.requests[2]?.questions ?? {})).toEqual(['word-3', 'word-3:refers']);
  expect(result.asked).toHaveLength(3);
  expect(result.oversized).toBe(0);
});
test('bannedRequests leaves out a candidate too large for any request and keeps the rest', () => {
  const small = { ...line, ...entry, word: 'invocation' };
  const huge = { ...small, text: 'x'.repeat(100_000) };
  const result = lib.bannedRequests([small, huge, small]);
  expect(result.oversized).toBe(1);
  expect(result.requests).toHaveLength(2);
  expect(result.requests.map((r) => Object.keys(r.questions))).toEqual([
    ['word-1', 'word-1:refers'],
    ['word-2', 'word-2:refers'],
  ]);
});
test('bannedQuestions with a start names the candidates from word-<start + 1>', () => {
  const candidate = { ...line, ...entry, word: 'invocation' };
  expect(Object.keys(lib.bannedQuestions([candidate], 16))).toEqual(['word-17', 'word-17:refers']);
});
test('bannedState and bannedQuestions name each candidate word-n with a noul and glossary sense', () => {
  const candidate = { ...line, ...entry, word: 'invocation' };
  expect(lib.bannedState([candidate])).toEqual({
    entries: { Call: { ...entry, avoidText: undefined } },
    lines: { 'line-1': line },
    candidates: { 'word-1': { word: 'invocation', entry: 'Call', location: 'line-1' } },
  });
  const questions = lib.bannedQuestions([candidate, candidate]);
  expect(Object.keys(questions)).toEqual(['word-1', 'word-1:refers', 'word-2', 'word-2:refers']);
  expect(questions['word-1']?.type).toBe('noul');
  expect(questions['word-2:refers']?.type).toBe('noul');
  expect(questions['word-2:refers']?.instructions).toBe(
    'In candidates.word-2, read its location in lines and its glossary entry in entries. Does "invocation" on that line refer to the thing the "Call" entry defines?',
  );
  expect(lib.BANNED_REFERS).toBe(0.5);
  expect(questions['word-2']?.instructions).toBe(
    'In candidates.word-2, read its location in lines and its glossary entry in entries (including avoidText). Is "invocation" used in the sense that entry forbids, where "Call" should be used instead?',
  );
  expect(lib.BANNED_YES).toBe(0.8);
});

const kinds: Entry[] = [
  { term: 'Kind', definition: 'D.', avoid: ['type'] },
  { term: 'Shadowing', definition: 'D.', avoid: ['extend'] },
  { term: 'Call', definition: 'D.', avoid: ['invocation'] },
];
function select(...rows: [string, string][]) {
  return selectRemoving(new Set(), ...rows);
}
function selectRemoving(removed: Set<string>, ...rows: [string, string][]) {
  const candidates = rows.flatMap(([file, text]) =>
    lib.bannedCandidates([{ file, line: 1, text, context: [] }], kinds),
  );
  return lib.bannedSelect(candidates, removed);
}
test('bannedSelect leaves out a JS keyword on a code line of a TypeScript file', () => {
  expect(select(['a.ts', 'type Foo = string;'])).toMatchObject({ selected: [], keyword: 1, repeat: 0 });
  expect(select(['a.ts', 'class A extends B {}'])).toMatchObject({ selected: [], keyword: 1 });
});
test('bannedSelect keeps an identifier, a comment, a doc line that hold the word', () => {
  expect(select(['a.ts', 'const stepType = 1;']).selected).toHaveLength(1);
  expect(select(['a.ts', '// which type of step']).selected).toHaveLength(1);
  expect(select(['note.md', 'type Foo = string;']).selected).toHaveLength(1);
});
test('bannedSelect asks the first three candidates per word, entry and file', () => {
  const result = select(
    ['a.ts', 'invocation one'],
    ['a.ts', 'invocation two'],
    ['a.ts', 'invocation three'],
    ['a.ts', 'invocation four'],
    ['a.ts', 'invocation five'],
    ['b.ts', 'invocation one'],
  );
  expect(result.selected.map((c) => [c.file, c.text])).toEqual([
    ['a.ts', 'invocation one'],
    ['a.ts', 'invocation two'],
    ['a.ts', 'invocation three'],
    ['b.ts', 'invocation one'],
  ]);
  expect(result.repeat).toBe(2);
});
const asked = (rows: [string, number][]) =>
  rows.map(([file, n]) => ({ ...line, ...entry, word: 'invocation', file, line: n }));
const noulAnswer = (noul: number) => ({ type: 'noul', noul });
/** `word-<n>` answers, each with a `word-<n>:refers` of 1. */
const refering = (answers: Record<string, unknown>) => ({
  ...answers,
  ...Object.fromEntries(
    Object.keys(answers)
      .filter((id) => !id.includes(':'))
      .map((id) => [`${id}:refers`, noulAnswer(1)]),
  ),
});
test('bannedHits flags a file once, on its highest-scoring flagged line, the earlier on a tie', () => {
  const rows = asked([
    ['a.md', 1],
    ['a.md', 2],
    ['a.md', 3],
  ]);
  const answers = { 'word-1': noulAnswer(0.85), 'word-2': noulAnswer(0.97), 'word-3': noulAnswer(0.9) };
  expect(lib.bannedHits(rows, refering(answers))).toEqual([
    { file: 'a.md', line: 2, word: 'invocation', term: 'Call', yes: 0.97 },
  ]);
  expect(lib.bannedHits(rows, refering({ 'word-1': noulAnswer(0.9), 'word-2': noulAnswer(0.9) }))).toEqual([
    { file: 'a.md', line: 1, word: 'invocation', term: 'Call', yes: 0.9 },
  ]);
});
test('bannedHits makes a hit for each file, and for each entry of one word and file', () => {
  const rows = [
    ...asked([
      ['a.md', 1],
      ['b.md', 1],
    ]),
    { ...(asked([['a.md', 4]])[0] as Candidate), term: 'Try' },
  ];
  const answers = { 'word-1': noulAnswer(0.9), 'word-2': noulAnswer(0.9), 'word-3': noulAnswer(0.9) };
  expect(lib.bannedHits(rows, refering(answers)).map((h) => [h.file, h.term])).toEqual([
    ['a.md', 'Call'],
    ['b.md', 'Call'],
    ['a.md', 'Try'],
  ]);
});
test('bannedHits ignores a missing or non-noul answer, and flags at 0.8 but not at 0.799', () => {
  const rows = asked([
    ['a.md', 1],
    ['b.md', 1],
    ['c.md', 1],
    ['d.md', 1],
  ]);
  const answers = {
    'word-1': noulAnswer(0.8),
    'word-2': noulAnswer(0.799),
    'word-3': { type: 'choice', choice: 'x' },
  };
  expect(lib.bannedHits(rows, refering(answers)).map((h) => h.file)).toEqual(['a.md']);
});
test('bannedHits needs the first noul at 0.8 and the second at 0.5', () => {
  const rows = asked([['a.md', 1]]);
  const hits = (yes: number, refers?: number) =>
    lib.bannedHits(rows, {
      'word-1': noulAnswer(yes),
      ...(refers === undefined ? {} : { 'word-1:refers': noulAnswer(refers) }),
    }).length;
  expect(hits(0.8, 0.5)).toBe(1);
  expect(hits(0.8, 0.49)).toBe(0);
  expect(hits(0.79, 1)).toBe(0);
  expect(hits(0.97)).toBe(0);
});
test('bannedSelect lets a keyword line not take the place of a later comment line', () => {
  const result = select(['a.ts', 'type Foo = string;'], ['a.ts', '// the type of it']);
  expect(result.selected.map((c) => c.text)).toEqual(['// the type of it']);
  expect(result.keyword).toBe(1);
});
test('bannedSelect keeps a keyword used as prose in a string literal or a trailing comment', () => {
  const lines = [
    "throw new Error('unknown type of step');",
    'const x = 1; // the type of the stage',
    'return `no such type`;',
    'fail("no such type");',
    'type A = 1; /* the type of it */',
    "type A = 'the \\'type\\' of it';",
  ];
  for (const text of lines) {
    const result = select(['a.ts', text]);
    expect({ text, selected: result.selected.length, keyword: result.keyword }).toEqual({
      text,
      selected: 1,
      keyword: 0,
    });
  }
});
test('bannedSelect leaves out a keyword in code beside a string or a comment that lacks the word', () => {
  for (const text of ["type Foo = 'x'; // done", 'type Foo = "x";', "const s = 'it\\'s'; type X = 1;"]) {
    expect({ text, ...select(['a.ts', text]) }).toMatchObject({ text, selected: [], keyword: 1 });
  }
});
test('the stage asks about a keyword in a string, a trailing comment and a template literal', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.97, 'word-2': 0.97, 'word-3': 0.97 });
    writeFileSync(join(repo.dir, 'CONTEXT.md'), '**Kind**:\nWhat a step is.\n_Avoid_: type\n');
    const diff =
      "+++ b/a.ts\n@@ -0,0 +1,1 @@\n+throw new Error('unknown type of step');\n" +
      '+++ b/b.ts\n@@ -0,0 +1,1 @@\n+const x = 1; // the type of the stage\n' +
      '+++ b/c.ts\n@@ -0,0 +1,1 @@\n+return `no such type`;\n';
    const out = join(repo.home, 'out');
    const result = stage(repo, diff);
    expect(requestQuestions(out, 3)).toEqual([
      ['word-1', 'word-1:refers'],
      ['word-2', 'word-2:refers'],
      ['word-3', 'word-3:refers'],
    ]);
    expect(result.output.jev).toMatchObject({
      candidates: 3,
      skipped: { keyword: 0, moved: 0, repeat: 0, oversized: 0 },
    });
  });
});
test('the stage asks the comment line and the identifier line, skips the keyword line, and flags the file once', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.85, 'word-2': 0.97 });
    writeFileSync(join(repo.dir, 'CONTEXT.md'), '**Kind**:\nWhat a step is.\n_Avoid_: type\n');
    const diff = '+++ b/a.ts\n@@ -0,0 +1,3 @@\n+type Foo = string;\n+// which type of step\n+const stepType = 1;\n';
    const out = join(repo.home, 'out');
    const result = stage(repo, diff);
    expect(requestQuestions(out, 2)).toEqual([
      ['word-1', 'word-1:refers'],
      ['word-2', 'word-2:refers'],
    ]);
    expect(result.output.hits).toEqual([{ file: 'a.ts', line: 3, word: 'type', term: 'Kind', yes: 0.97 }]);
    expect(result.output.jev).toEqual({
      asked: true,
      failed: false,
      note: '',
      threshold: 0.8,
      candidates: 3,
      requests: 2,
      skipped: { keyword: 1, moved: 0, repeat: 0, oversized: 0 },
    });
    expect(result.stderr).toContain('not asked: 1 keyword');
  });
});
test('the stage asks three of five lines of one word in one file and counts two as repeats', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.05, 'word-2': 0.05, 'word-3': 0.05 });
    const diff = `+++ b/a.md\n@@ -0,0 +1,5 @@\n${Array.from({ length: 5 }, (_, i) => `+invocation ${i}\n`).join('')}`;
    const result = stage(repo, diff);
    expect(requestQuestions(join(repo.home, 'out'), 3).map(([first]) => first)).toEqual(['word-1', 'word-2', 'word-3']);
    expect(existsSync(join(repo.home, 'out', 'jev-request-4.json'))).toBe(false);
    expect(result.output.jev).toMatchObject({ candidates: 5, skipped: { repeat: 2 } });
  });
});
/**
 * A `sail` ahead of the checkout's on the PATH that fails the `port jev ask` of each request numbered in `failing` (the
 * request file's name, `jev-request.json` being 1), as an unreachable Jev does, and passes every other call through;
 * `asks()` counts the asks it saw.
 */
function failingJev(repo: TempRepo, failing: number[]) {
  const dir = join(repo.home, 'failing-jev');
  mkdirSync(dir);
  const log = join(dir, 'log');
  const names = failing.map((n) => (n === 1 ? '*/jev-request.json' : `*/jev-request-${n}.json`)).join('|');
  writeFileSync(
    join(dir, 'sail'),
    [
      '#!/bin/sh',
      'for last; do :; done',
      `echo "$last" >> '${log}'`,
      `case "$last" in ${names}) echo "jev ask: Jev could not be reached" >&2; exit 1;; esac`,
      `exec '${join(import.meta.dir, '../../bin/sail')}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { dir, asks: () => readFileSync(log, 'utf8').trim().split('\n').length };
}
const low = (n: number, high: Record<string, number>) => ({
  ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`word-${i + 1}`, 0.05])),
  ...high,
});
const candidateFiles = (n: number) =>
  Array.from({ length: n }, (_, i) => `+++ b/f${i + 1}.md\n@@ -0,0 +1 @@\n+invocation\n`).join('');
const NOT_ASKED = /^\d+ of \d+ requests not asked: jev ask: Jev could not be reached$/;
test('the stage keeps the first request’s hit and notes the refused second as not asked', async () => {
  await withTempRepo((repo) => {
    setup(repo, low(3, { 'word-1': 0.97 }));
    const jev = failingJev(repo, [2]);
    const result = stage(repo, candidateFiles(3), undefined, jev.dir);
    expect(result.code).toBe(0);
    expect(result.output.hits).toEqual([{ file: 'f1.md', line: 1, word: 'invocation', term: 'Call', yes: 0.97 }]);
    expect(result.output.jev).toMatchObject({ asked: true, failed: false, requests: 3 });
    expect(result.output.jev.note).toMatch(NOT_ASKED);
  });
}, 120_000);
test('the stage reports a failed check when every request it asked was refused', async () => {
  await withTempRepo((repo) => {
    setup(repo, low(3, { 'word-1': 0.97 }));
    const jev = failingJev(repo, [1, 2, 3]);
    const result = stage(repo, candidateFiles(3), undefined, jev.dir);
    expect(result.code).toBe(0);
    expect(result.output.hits).toEqual([]);
    expect(result.output.jev).toMatchObject({
      asked: false,
      failed: true,
      note: 'jev ask: Jev could not be reached',
    });
  });
}, 120_000);
test('the stage stops starting requests once Jev fails one, leaving the rest not asked', async () => {
  await withTempRepo((repo) => {
    setup(repo, low(6, { 'word-1': 0.97, 'word-6': 0.97 }));
    const jev = failingJev(repo, [2]);
    const result = stage(repo, candidateFiles(6), undefined, jev.dir);
    expect(jev.asks()).toBeGreaterThanOrEqual(2);
    expect(jev.asks()).toBeLessThan(6);
    expect(result.output.hits).toEqual([{ file: 'f1.md', line: 1, word: 'invocation', term: 'Call', yes: 0.97 }]);
    expect(result.output.jev.note).toMatch(NOT_ASKED);
  });
}, 120_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test('bannedAsk asks no request once its deadline has passed, and counts the rest not asked', async () => {
  let clock = 0;
  const asked: number[] = [];
  const { results, unasked, reason } = await lib.bannedAsk(
    ['a', 'b', 'c', 'd'],
    async (_request, i) => {
      asked.push(i);
      clock += 200_000;
      return { asked: true, answers: {} };
    },
    { deadlineMs: 400_000, now: () => clock, concurrency: 1 },
  );
  expect(asked).toEqual([0, 1]);
  expect(results).toHaveLength(2);
  expect(unasked).toBe(2);
  expect(reason).toBe('the stage’s 400 s for asking Jev ran out');
});
test('bannedAsk stops at the first failed ask and asks every request when none fails', async () => {
  const failing = await lib.bannedAsk([1, 2, 3], async (_r, i) =>
    i === 0 ? { asked: false, failed: true, note: 'down' } : {},
  );
  expect(failing).toMatchObject({ reason: 'down' });
  expect(failing.results.length + failing.unasked).toBe(3);
  const single = await lib.bannedAsk([1, 2, 3], async () => ({ asked: false, failed: true, note: 'down' }), {
    concurrency: 1,
  });
  expect(single).toMatchObject({ unasked: 2, reason: 'down' });
  expect(single.results).toHaveLength(1);
  const all = await lib.bannedAsk([1, 2, 3], async () => ({ asked: true, answers: {} }));
  expect(all).toMatchObject({ unasked: 0, reason: '' });
  expect(all.results).toHaveLength(3);
});
test('bannedAsk has at most four asks in flight and returns results in request order', async () => {
  let flying = 0;
  let most = 0;
  const { results, unasked } = await lib.bannedAsk(
    Array.from({ length: 10 }, (_, i) => i),
    async (request) => {
      flying++;
      most = Math.max(most, flying);
      await sleep((10 - request) * 4);
      flying--;
      return { asked: true, answers: { [`word-${request}`]: request } };
    },
  );
  expect(lib.BANNED_CONCURRENCY).toBe(4);
  expect(most).toBe(4);
  expect(unasked).toBe(0);
  expect(results.map((r) => Object.keys(r.answers ?? {})[0])).toEqual(
    Array.from({ length: 10 }, (_, i) => `word-${i}`),
  );
});
test('bannedAsk starts no request after a failed result, waits for those in flight and returns the started prefix', async () => {
  const started: number[] = [];
  const finished: number[] = [];
  const { results, unasked, reason } = await lib.bannedAsk(
    [0, 1, 2, 3, 4, 5],
    async (_request, i) => {
      started.push(i);
      if (i === 1) {
        await sleep(25);
        finished.push(i);
        return { asked: false, failed: true, note: 'down' };
      }
      await sleep(i === 0 ? 5 : 60);
      finished.push(i);
      return { asked: true, answers: {} };
    },
    { concurrency: 2 },
  );
  expect(started).toEqual([0, 1, 2]);
  expect(finished).toEqual([0, 1, 2]);
  expect(results).toHaveLength(3);
  expect(results[1]).toMatchObject({ failed: true });
  expect(unasked).toBe(3);
  expect(reason).toBe('down');
});
