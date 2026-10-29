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
  bannedState(candidates: Candidate[]): unknown;
  bannedQuestions(candidates: Candidate[]): Record<string, { type: string; instructions: string }>;
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
  return { code: child.exitCode, output: JSON.parse(child.stdout.toString()), request: join(out, 'jev-request.json') };
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
      jev: { asked: true, note: '', threshold: 0.8, candidates: 1 },
    });
  });
});
test('the stage, with Jev answering word-1 0.05, reports no hit', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.05 });
    const result = stage(repo, doc);
    expect(result.output.hits).toEqual([]);
    expect(result.output.jev.asked).toBe(true);
  });
});
test('the stage asks Jev nothing when no added line holds an avoided word', async () => {
  await withTempRepo((repo) => {
    setup(repo, {});
    const result = stage(repo, '+++ b/x.ts\n@@ -0,0 +1 @@\n+const x = 1;\n');
    expect(result.output.jev).toEqual({
      asked: false,
      note: 'no avoided word on an added line',
      threshold: 0.8,
      candidates: 0,
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
      candidates: {
        'word-1': {
          ...entry,
          avoidText: 'invocation',
          word: 'invocation',
          file: 'a.ts',
          line: 2,
          text: 'invocation',
          context: [{ line: 1, text: 'before' }],
        },
      },
    });
  });
});
test('the stage includes answers exactly at the threshold but excludes answers just below it', async () => {
  await withTempRepo((repo) => {
    setup(repo, { 'word-1': 0.8, 'word-2': 0.799 });
    const result = stage(repo, `${doc}+invocation\n`);
    expect(result.output.hits).toEqual([{ file: 'note.md', line: 1, word: 'invocation', term: 'Call', yes: 0.8 }]);
    expect(result.output.jev.candidates).toBe(2);
  });
});
test('the stage with no CONTEXT.md makes no Jev request', async () => {
  await withTempRepo((repo) => {
    setup(repo, {});
    unlinkSync(join(repo.dir, 'CONTEXT.md'));
    const result = stage(repo, doc);
    expect(result.output.jev).toEqual({ asked: false, note: 'no CONTEXT.md', threshold: 0.8, candidates: 0 });
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
      note: 'no avoided word on an added line',
      threshold: 0.8,
      candidates: 0,
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
test('Jev receives the full Avoid wording, including sense qualifiers', () => {
  const glossary = lib.parseGlossary('**Call**:\nOne invocation.\n_Avoid_: invocation (as a noun), execution\n');
  const candidates = lib.bannedCandidates([line], glossary);
  expect(candidates.map((candidate) => candidate.word)).toEqual(['invocation']);
  expect(JSON.stringify(lib.bannedState(candidates))).toContain('invocation (as a noun), execution');
});

test('bannedCandidates matches whole words ignoring case but not plurals or hyphen joins', () => {
  const glossary = [entry, { term: 'sail', definition: 'Tool.', avoid: ['ADW', 'loop', 'retry loop', 'a.b'] }];
  expect(lib.bannedCandidates([line], glossary)).toEqual([{ ...line, ...entry, word: 'invocation' }]);
  expect(lib.bannedCandidates([{ ...line, text: 'invocations ADW-387 run-loop axb' }], glossary)).toEqual([]);
  expect(lib.bannedCandidates([{ ...line, text: 'retry  loop a.b' }], glossary).map((c) => c.word)).toEqual([
    'loop',
    'retry loop',
    'a.b',
  ]);
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
test('bannedState and bannedQuestions name each candidate word-n with a noul and glossary sense', () => {
  const candidate = { ...line, ...entry, word: 'invocation' };
  expect(lib.bannedState([candidate])).toEqual({ candidates: { 'word-1': candidate } });
  const questions = lib.bannedQuestions([candidate, candidate]);
  expect(Object.keys(questions)).toEqual(['word-1', 'word-2']);
  expect(questions['word-1']?.type).toBe('noul');
  expect(questions['word-2']?.instructions).toBe(
    'In candidates.word-2, is "invocation" used in the sense the glossary entry for Call forbids, where "Call" should be used instead?',
  );
  expect(lib.BANNED_YES).toBe(0.8);
});
