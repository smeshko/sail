import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Entry {
  term: string;
  definition: string;
  avoid: string[];
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
    { term: 'Call', definition: 'One invocation.', avoid: ['attempt', 'execution', 'stage run', 'invocation'] },
    { term: 'Watcher registry', definition: 'The record.', avoid: ['registry', 'roster', 'manifest'] },
    { term: 'Loop', definition: 'A repetition.', avoid: ['cycle', 'retry loop', 'while', 'loop'] },
    { term: 'System One', definition: 'The API.', avoid: [] },
    { term: 'Outcome', definition: 'How it ended:\n- passed\n- failed', avoid: ['status'] },
  ]);
});
test('parseGlossary reads real Call and Branch entries without long prose words', () => {
  const entries = lib.parseGlossary(readFileSync(join(import.meta.dir, '../../CONTEXT.md'), 'utf8'));
  expect(entries.find((e) => e.term === 'Call')?.avoid).toEqual(['attempt', 'execution', 'stage run', 'invocation']);
  expect(entries.find((e) => e.term === 'Branch')?.avoid).toEqual(['branch']);
  expect(entries.flatMap((e) => e.avoid).filter((word) => word.split(/\s+/).length > 3)).toEqual([]);
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
