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
  messageContext(lines: Omit<Line, 'context'>[]): Line[];
  bannedCandidates(lines: Line[], glossary: Entry[]): Candidate[];
  bannedPattern(word: string): RegExp;
  bannedMatches(pattern: RegExp, text: string): boolean;
  bannedState(candidates: Candidate[], start?: number): unknown;
  BANNED_BATCH: number;
  JS_KEYWORDS: Set<string>;
  bannedSelect(candidates: Candidate[]): { selected: Candidate[]; keyword: number; repeat: number };
  bannedRequests(candidates: Candidate[]): {
    requests: { candidates: Candidate[]; state: unknown; questions: Record<string, unknown> }[];
    asked: Candidate[];
    oversized: number;
  };
  bannedQuestions(candidates: Candidate[], start?: number): Record<string, { type: string; instructions: string }>;
}
const lib = (await import(join(import.meta.dir, '../../.sail/lib/jev-check.mjs'))) as Lib;
const entry = { term: 'Call', definition: 'One invocation.', avoid: ['invocation'] };
const glossary = '**Call**:\nOne invocation.\n_Avoid_: invocation\n';
const doc = '+++ b/note.md\n@@ -0,0 +1 @@\n+Each invocation of a stage\n';
function stage(repo: TempRepo, diff: string, base = repo.git('rev-parse', 'HEAD').trim()) {
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
      PATH: `${join(import.meta.dir, '../../bin')}:${repo.env.PATH}`,
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
        skipped: { keyword: 0, repeat: 0, oversized: 0 },
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
      skipped: { keyword: 0, repeat: 0, oversized: 0 },
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
      skipped: { keyword: 0, repeat: 0, oversized: 0 },
    });
    expect(existsSync(result.request)).toBe(false);
  });
});
test('the stage scans commit messages since the base', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.97 });
    const base = repo.git('rev-parse', 'HEAD').trim();
    repo.git('commit', '--allow-empty', '-m', 'invocation');
    const sha = repo.git('rev-parse', '--short', 'HEAD').trim();
    expect(stage(repo, '', base).output.hits).toEqual([
      { file: `commit ${sha}`, line: 1, word: 'invocation', term: 'Call', yes: 0.97 },
    ]);
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
      skipped: { keyword: 0, repeat: 0, oversized: 0 },
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
      skipped: { keyword: 0, repeat: 0, oversized: 0 },
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
test('messageContext uses only nearby lines from the same commit', () => {
  expect(
    lib.messageContext([
      { file: 'commit abc', line: 1, text: 'subject' },
      { file: 'commit abc', line: 3, text: 'body' },
      { file: 'commit abc', line: 6, text: 'far' },
      { file: 'commit def', line: 1, text: 'other' },
    ]),
  ).toEqual([
    { file: 'commit abc', line: 1, text: 'subject', context: [{ line: 3, text: 'body' }] },
    {
      file: 'commit abc',
      line: 3,
      text: 'body',
      context: [
        { line: 1, text: 'subject' },
        { line: 6, text: 'far' },
      ],
    },
    { file: 'commit abc', line: 6, text: 'far', context: [{ line: 3, text: 'body' }] },
    { file: 'commit def', line: 1, text: 'other', context: [] },
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
  const candidates = rows.flatMap(([file, text]) =>
    lib.bannedCandidates([{ file, line: 1, text, context: [] }], kinds),
  );
  return lib.bannedSelect(candidates);
}
test('bannedSelect leaves out a JS keyword on a code line of a TypeScript file', () => {
  expect(select(['a.ts', 'type Foo = string;'])).toMatchObject({ selected: [], keyword: 1, repeat: 0 });
  expect(select(['a.ts', 'class A extends B {}'])).toMatchObject({ selected: [], keyword: 1 });
});
test('bannedSelect keeps an identifier, a comment, a doc line and a commit message that hold the word', () => {
  expect(select(['a.ts', 'const stepType = 1;']).selected).toHaveLength(1);
  expect(select(['a.ts', '// which type of step']).selected).toHaveLength(1);
  expect(select(['note.md', 'type Foo = string;']).selected).toHaveLength(1);
  expect(select(['commit abc1234', 'return type;']).selected).toHaveLength(1);
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
test('bannedSelect lets a keyword line not take the place of a later comment line', () => {
  const result = select(['a.ts', 'type Foo = string;'], ['a.ts', '// the type of it']);
  expect(result.selected.map((c) => c.text)).toEqual(['// the type of it']);
  expect(result.keyword).toBe(1);
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
      skipped: { keyword: 1, repeat: 1, oversized: 0 },
    });
    expect(result.stderr).toContain('not asked: 1 keyword, 1 repeat');
  });
});
