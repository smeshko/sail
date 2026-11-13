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
  BANNED_BATCH: number;
  JS_KEYWORDS: Set<string>;
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
  bannedAsk<R, A extends { asked?: boolean; failed?: boolean; note?: string }>(
    requests: R[],
    ask: (request: R, i: number) => A,
    options?: { deadlineMs?: number; now?: () => number },
  ): { results: A[]; unasked: number; reason: string };
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
function requestFiles(out: string) {
  return [1, 2, 3, 4, 5, 6].map((n) => join(out, n === 1 ? 'jev-request.json' : `jev-request-${n}.json`));
}
test('the stage asks 40 candidates in requests of 16, 16 and 8 numbered across them', async () => {
  await withTempRepo((repo) => {
    setup(repo, Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`word-${i + 1}`, i === 32 ? 0.97 : 0.05])));
    const files = Array.from({ length: 40 }, (_, i) => `+++ b/f${i + 1}.md\n@@ -0,0 +1 @@\n+invocation\n`).join('');
    const result = stage(repo, files);
    const [one, two, three, four] = requestFiles(join(repo.home, 'out'));
    expect(existsSync(one as string) && existsSync(two as string) && existsSync(three as string)).toBe(true);
    expect(existsSync(four as string)).toBe(false);
    const names = [one, two, three].map((f) => Object.keys(JSON.parse(readFileSync(f as string, 'utf8')).questions));
    expect(names[0]).toEqual(Array.from({ length: 16 }, (_, i) => `word-${i + 1}`));
    expect(names[1]).toEqual(Array.from({ length: 16 }, (_, i) => `word-${i + 17}`));
    expect(names[2]).toEqual(Array.from({ length: 8 }, (_, i) => `word-${i + 33}`));
    expect(result.output.jev).toEqual({
      asked: true,
      failed: false,
      note: '',
      threshold: 0.8,
      candidates: 40,
      requests: 3,
      skipped: { keyword: 0, moved: 0, repeat: 0, oversized: 0 },
    });
    expect(result.output.hits).toEqual([{ file: 'f33.md', line: 1, word: 'invocation', term: 'Call', yes: 0.97 }]);
  });
}, 120_000);
test('the stage splits long multibyte lines into requests under the byte limit and asks them all', async () => {
  await withTempRepo((repo) => {
    setup(repo, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`word-${i + 1}`, 0.05])));
    const files = Array.from(
      { length: 30 },
      (_, i) => `+++ b/f${i + 1}.md\n@@ -0,0 +1 @@\n+invocation ${'界'.repeat(2000)}\n`,
    ).join('');
    const result = stage(repo, files);
    const present = requestFiles(join(repo.home, 'out')).filter((f) => existsSync(f));
    const names: string[] = [];
    for (const f of present) {
      const text = readFileSync(f, 'utf8');
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64_000);
      const keys = Object.keys(JSON.parse(text).questions);
      expect(keys.length).toBeLessThan(16);
      names.push(...keys);
    }
    expect(names).toEqual(Array.from({ length: 30 }, (_, i) => `word-${i + 1}`));
    expect(result.output.jev.note).toBe('');
  });
}, 120_000);
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
test('bannedRequests makes requests of 16, numbering word-n across them', () => {
  const small = { ...line, ...entry, word: 'invocation' };
  const result = lib.bannedRequests(Array.from({ length: 17 }, () => small));
  expect(result.requests.map((r) => r.candidates.length)).toEqual([lib.BANNED_BATCH, 1]);
  expect(Object.keys(result.requests[1]?.questions ?? {})).toEqual(['word-17']);
  expect(result.asked).toHaveLength(17);
  expect(result.oversized).toBe(0);
});
test('bannedRequests leaves out a candidate too large for any request and keeps the rest in one', () => {
  const small = { ...line, ...entry, word: 'invocation' };
  const huge = { ...small, text: 'x'.repeat(100_000) };
  const result = lib.bannedRequests([small, huge, small]);
  expect(result.oversized).toBe(1);
  expect(result.requests).toHaveLength(1);
  expect(Object.keys(result.requests[0]?.questions ?? {})).toEqual(['word-1', 'word-2']);
});
test('bannedQuestions with a start names the candidates from word-<start + 1>', () => {
  const candidate = { ...line, ...entry, word: 'invocation' };
  expect(Object.keys(lib.bannedQuestions([candidate], 16))).toEqual(['word-17']);
});
test('bannedState and bannedQuestions name each candidate word-n with a noul and glossary sense', () => {
  const candidate = { ...line, ...entry, word: 'invocation' };
  expect(lib.bannedState([candidate])).toEqual({
    entries: { Call: { ...entry, avoidText: undefined } },
    lines: { 'line-1': line },
    candidates: { 'word-1': { word: 'invocation', entry: 'Call', location: 'line-1' } },
  });
  const questions = lib.bannedQuestions([candidate, candidate]);
  expect(Object.keys(questions)).toEqual(['word-1', 'word-2']);
  expect(questions['word-1']?.type).toBe('noul');
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
test('bannedSelect asks one candidate per word, entry and file, the first', () => {
  const result = select(
    ['a.ts', 'invocation one'],
    ['a.ts', 'invocation two'],
    ['a.ts', 'invocation three'],
    ['b.ts', 'invocation one'],
  );
  expect(result.selected.map((c) => [c.file, c.text])).toEqual([
    ['a.ts', 'invocation one'],
    ['b.ts', 'invocation one'],
  ]);
  expect(result.repeat).toBe(2);
});
test('bannedRemoved holds every removed line of every file, trimmed and with whitespace runs made one space', () => {
  const diff = [
    'diff --git a/a.md b/a.md',
    '--- a/a.md',
    '+++ b/a.md',
    '@@ -1,3 +1,1 @@',
    ' keep',
    '-\t  Each   invocation of a stage  ',
    '-}',
    '+added',
    'diff --git a/b.json b/b.json',
    '--- a/b.json',
    '+++ b/b.json',
    '@@ -1,2 +1,1 @@',
    '-"invocation": 1,',
    '--- x',
    '+y',
    '',
  ].join('\n');
  expect([...lib.bannedRemoved(diff)].sort()).toEqual(['"invocation": 1,', '-- x', 'Each invocation of a stage']);
});
test('bannedSelect counts a line the diff only moved or re-indented as moved, and asks one that differs in a word', () => {
  const removed = new Set(['Each invocation of a stage']);
  const moved = selectRemoving(removed, ['new.md', '    Each  invocation of a stage']);
  expect(moved).toMatchObject({ selected: [], moved: 1, keyword: 0, repeat: 0 });
  const changed = selectRemoving(removed, ['new.md', 'Each invocation of a step']);
  expect(changed.selected).toHaveLength(1);
  expect(changed.moved).toBe(0);
});
test('bannedSelect counts a keyword line as keyword, not moved', () => {
  const result = selectRemoving(new Set(['type Foo = string;']), ['a.ts', 'type Foo = string;']);
  expect(result).toMatchObject({ selected: [], keyword: 1, moved: 0 });
});
test('the stage does not ask a line removed from another file and counts it moved', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.97 });
    const diff =
      '+++ b/old.md\n@@ -1 +0,0 @@\n-Each invocation of a stage\n' +
      '+++ b/new.md\n@@ -0,0 +1,2 @@\n+    Each invocation of a stage\n+Another invocation here\n';
    const result = stage(repo, diff);
    const asked = JSON.parse(readFileSync(result.request, 'utf8'));
    expect(Object.values(asked.state.lines).map((l) => (l as { text: string }).text)).toEqual([
      'Another invocation here',
    ]);
    expect(result.output.jev).toMatchObject({
      candidates: 2,
      requests: 1,
      skipped: { keyword: 0, moved: 1, repeat: 0, oversized: 0 },
    });
    expect(result.stderr).toContain('not asked: 1 moved');
  });
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
    expect(Object.keys(JSON.parse(readFileSync(join(out, 'jev-request.json'), 'utf8')).questions)).toEqual([
      'word-1',
      'word-2',
      'word-3',
    ]);
    expect(result.output.jev).toMatchObject({
      candidates: 3,
      skipped: { keyword: 0, moved: 0, repeat: 0, oversized: 0 },
    });
  });
});
test('the stage asks one question for three lines of a TypeScript file and reports the two skipped', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.97 });
    writeFileSync(join(repo.dir, 'CONTEXT.md'), '**Kind**:\nWhat a step is.\n_Avoid_: type\n');
    const diff = '+++ b/a.ts\n@@ -0,0 +1,3 @@\n+type Foo = string;\n+// which type of step\n+const stepType = 1;\n';
    const out = join(repo.home, 'out');
    const result = stage(repo, diff);
    expect(Object.keys(JSON.parse(readFileSync(join(out, 'jev-request.json'), 'utf8')).questions)).toEqual(['word-1']);
    expect(result.output.hits).toEqual([{ file: 'a.ts', line: 2, word: 'type', term: 'Kind', yes: 0.97 }]);
    expect(result.output.jev).toEqual({
      asked: true,
      failed: false,
      note: '',
      threshold: 0.8,
      candidates: 3,
      requests: 1,
      skipped: { keyword: 1, moved: 0, repeat: 1, oversized: 0 },
    });
    expect(result.stderr).toContain('not asked: 1 keyword, 1 repeat');
  });
});
/**
 * A `sail` ahead of the checkout's on the PATH that fails its `failing`-th `port jev ask`, as an unreachable Jev does,
 * and passes every other call through; `asks()` counts the asks it saw.
 */
function failingJev(repo: TempRepo, failing: number[]) {
  const dir = join(repo.home, 'failing-jev');
  mkdirSync(dir);
  const count = join(dir, 'count');
  writeFileSync(
    join(dir, 'sail'),
    [
      '#!/bin/sh',
      `n=$(($(cat '${count}' 2>/dev/null || echo 0) + 1))`,
      `echo "$n" > '${count}'`,
      `case " ${failing.join(' ')} " in *" $n "*) echo "jev ask: Jev could not be reached" >&2; exit 1;; esac`,
      `exec '${join(import.meta.dir, '../../bin/sail')}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { dir, asks: () => Number(readFileSync(count, 'utf8').trim()) };
}
const low = (n: number, high: Record<string, number>) => ({
  ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`word-${i + 1}`, 0.05])),
  ...high,
});
const candidateFiles = (n: number) =>
  Array.from({ length: n }, (_, i) => `+++ b/f${i + 1}.md\n@@ -0,0 +1 @@\n+invocation\n`).join('');
test('the stage keeps the first request’s hits and notes the second, refused, as not asked', async () => {
  await withTempRepo((repo) => {
    setup(repo, low(17, { 'word-2': 0.97, 'word-17': 0.97 }));
    const jev = failingJev(repo, [2]);
    const result = stage(repo, candidateFiles(17), undefined, jev.dir);
    expect(result.code).toBe(0);
    expect(jev.asks()).toBe(2);
    expect(result.output.hits).toEqual([{ file: 'f2.md', line: 1, word: 'invocation', term: 'Call', yes: 0.97 }]);
    expect(result.output.jev).toMatchObject({ asked: true, failed: false, requests: 2 });
    expect(result.output.jev.note).toBe('1 of 2 requests not asked: jev ask: Jev could not be reached');
  });
}, 120_000);
test('the stage reports a failed check when every request it asked was refused', async () => {
  await withTempRepo((repo) => {
    setup(repo, low(17, { 'word-1': 0.97 }));
    const jev = failingJev(repo, [1, 2]);
    const result = stage(repo, candidateFiles(17), undefined, jev.dir);
    expect(result.code).toBe(0);
    expect(result.output.hits).toEqual([]);
    expect(result.output.jev).toMatchObject({
      asked: false,
      failed: true,
      note: 'jev ask: Jev could not be reached',
    });
  });
}, 120_000);
test('the stage stops asking at the first request Jev fails, leaving the rest not asked', async () => {
  await withTempRepo((repo) => {
    setup(repo, low(40, { 'word-1': 0.97, 'word-40': 0.97 }));
    const jev = failingJev(repo, [2]);
    const result = stage(repo, candidateFiles(40), undefined, jev.dir);
    expect(jev.asks()).toBe(2);
    expect(result.output.hits).toEqual([{ file: 'f1.md', line: 1, word: 'invocation', term: 'Call', yes: 0.97 }]);
    expect(result.output.jev.note).toBe('2 of 3 requests not asked: jev ask: Jev could not be reached');
  });
}, 120_000);
test('bannedAsk asks no request once its deadline has passed, and counts the rest not asked', () => {
  let clock = 0;
  const asked: number[] = [];
  const { results, unasked, reason } = lib.bannedAsk(
    ['a', 'b', 'c', 'd'],
    (_request, i) => {
      asked.push(i);
      clock += 200_000;
      return { asked: true, answers: {} };
    },
    { deadlineMs: 400_000, now: () => clock },
  );
  expect(asked).toEqual([0, 1]);
  expect(results).toHaveLength(2);
  expect(unasked).toBe(2);
  expect(reason).toBe('the stage’s 400 s for asking Jev ran out');
});
test('bannedAsk stops at the first failed ask and asks every request when none fails', () => {
  const failing = lib.bannedAsk([1, 2, 3], (_r, i) => (i === 0 ? { asked: false, failed: true, note: 'down' } : {}));
  expect(failing).toMatchObject({ unasked: 2, reason: 'down' });
  expect(failing.results).toHaveLength(1);
  const all = lib.bannedAsk([1, 2, 3], () => ({ asked: true, answers: {} }));
  expect(all).toMatchObject({ unasked: 0, reason: '' });
  expect(all.results).toHaveLength(3);
});
