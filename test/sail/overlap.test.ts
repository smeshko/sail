// groom's overlap comparison (.sail/lib/overlap.mjs): the paths a plan names, the paths two plans share, the plan
// attached last, and the order overlapping tickets are tried in.
import { beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';

interface Candidate {
  ticketKey: string;
  attachedAt: string;
  shared: string[];
}

interface Overlap {
  IGNORED: string[];
  planPaths(planText: string, parseTasks: (plan: string) => { paths: string[] }[]): string[];
  sharedPaths(mine: readonly string[], theirs: readonly string[]): string[];
  lastPlan(files: { name: string; text: string }[]): { name: string; text: string; attachedAt: string } | undefined;
  byRecency(candidates: Candidate[]): Candidate[];
  why(shared: readonly string[]): string;
}

const ROOT = join(import.meta.dir, '..', '..');
let lib: Overlap;
let jev: { parseTasks(plan: string): { id: string; paths: string[] }[] };
beforeAll(async () => {
  lib = (await import(join(ROOT, '.sail', 'lib', 'overlap.mjs'))) as Overlap;
  jev = await import(join(ROOT, '.sail', 'lib', 'jev-check.mjs'));
});

/** A plan of two tasks, each with the Files block given. */
function plan(first: string, second: string): string {
  return `# Plan: a thing

## Tasks

- [ ] TASK-001: First
- [ ] TASK-002: Second

## Task details

### TASK-001: First

Type: impl

Files:
- ${first}

Acceptance:
- [ ] it works, see \`src/never.ts\`

### TASK-002: Second

Type: impl

Files: ${second}

Acceptance:
- [ ] it works
`;
}

const attached = (attachedAt: unknown) => `# Plan\n\n<!-- sail:plan ${JSON.stringify({ version: 1, attachedAt })} -->\n`;

test('planPaths names each path of the tasks once, without a leading ./, a :line or CONTEXT.md', () => {
  const text = plan('`src/a.ts` (new), `CONTEXT.md`, a term', '`./src/a.ts`, and `test/a.test.ts:12`');
  expect(lib.planPaths(text, jev.parseTasks)).toEqual(['src/a.ts', 'test/a.test.ts']);
  expect(lib.IGNORED).toEqual(['CONTEXT.md']);
});

test('planPaths of a plan with no task details is empty', () => {
  expect(lib.planPaths('# Plan: nothing\n', jev.parseTasks)).toEqual([]);
});

test('sharedPaths is empty for two plans that share only CONTEXT.md, and names a path both change', () => {
  const mine = lib.planPaths(plan('`CONTEXT.md`', '`src/a.ts`'), jev.parseTasks);
  const theirs = lib.planPaths(plan('`CONTEXT.md`', '`src/b.ts`'), jev.parseTasks);
  expect(lib.sharedPaths(mine, theirs)).toEqual([]);
  expect(
    lib.sharedPaths(
      ['src/x.ts', 'src/dashboard/page/app.ts', 'src/a.ts'],
      ['src/a.ts', 'src/dashboard/page/app.ts', 'src/y.ts'],
    ),
  ).toEqual(['src/dashboard/page/app.ts', 'src/a.ts']);
});

test('lastPlan picks the plan attached last, and passes over a file with no trailer, a trailer that is no JSON and one without attachedAt', () => {
  const files = [
    { name: 'notes.md', text: '# Notes\n' },
    { name: 'older', text: attached('2026-11-01T09:00:00.000Z') },
    { name: 'newer', text: `${attached('2026-11-02T09:00:00.000Z')}\n\n` },
    { name: 'broken', text: '# Plan\n\n<!-- sail:plan {not json} -->\n' },
    { name: 'undated', text: '# Plan\n\n<!-- sail:plan {"version":1} -->\n' },
    { name: 'numbered', text: attached(20261103) },
    { name: 'empty', text: '' },
  ];
  expect(lib.lastPlan(files)).toEqual({
    name: 'newer',
    text: `${attached('2026-11-02T09:00:00.000Z')}\n\n`,
    attachedAt: '2026-11-02T09:00:00.000Z',
  });
  expect(lib.lastPlan(files.reverse())?.name).toBe('newer');
});

test('lastPlan of files that hold no plan is undefined', () => {
  expect(lib.lastPlan([])).toBeUndefined();
  expect(lib.lastPlan([{ name: 'notes.md', text: '# Notes\n' }])).toBeUndefined();
});

test('byRecency drops a candidate with nothing shared and puts the plan attached last first, ties by ticket key', () => {
  const candidates = [
    { ticketKey: 'FAKE-1', attachedAt: '2026-11-01T09:00:00.000Z', shared: ['src/a.ts'] },
    { ticketKey: 'FAKE-9', attachedAt: '2026-11-09T09:00:00.000Z', shared: [] },
    { ticketKey: 'FAKE-4', attachedAt: '2026-11-03T09:00:00.000Z', shared: ['src/a.ts'] },
    { ticketKey: 'FAKE-3', attachedAt: '2026-11-03T09:00:00.000Z', shared: ['src/b.ts'] },
  ];
  expect(lib.byRecency(candidates).map((each) => each.ticketKey)).toEqual(['FAKE-3', 'FAKE-4', 'FAKE-1']);
});

test('why names up to three shared paths, then how many more', () => {
  expect(lib.why(['src/a.ts'])).toBe('its plan also changes `src/a.ts`');
  expect(lib.why(['src/a.ts', 'src/b.ts', 'src/c.ts'])).toBe('its plan also changes `src/a.ts`, `src/b.ts`, `src/c.ts`');
  expect(lib.why(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'])).toBe(
    'its plan also changes `src/a.ts`, `src/b.ts`, `src/c.ts` and 1 more',
  );
});
