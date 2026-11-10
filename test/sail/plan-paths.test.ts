// groom's plan check: every path a task's Files block names must be one implement's write globs cover.
import { beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerSail } from '../../src/engine/definitions';
import type { DocumentContent, Validator } from '../../src/sdk/documents';

interface PlanPaths {
  taskPaths(text: string): { id: string; paths: string[] }[];
  implementWrites(globs: readonly string[]): Validator;
}

const ROOT = join(import.meta.dir, '..', '..');
let lib: PlanPaths;
let builderWrite: readonly string[];
let jev: { parseTasks(plan: string): { id: string; paths: string[] }[] };
beforeAll(async () => {
  registerSail();
  lib = (await import(join(ROOT, '.sail', 'lib', 'plan-paths.ts'))) as PlanPaths;
  builderWrite = (
    (await import(join(ROOT, '.sail', 'lib', 'permissions.ts'))) as { builder: { write: readonly string[] } }
  ).builder.write;
  jev = await import(join(ROOT, '.sail', 'lib', 'jev-check.mjs'));
});

function plan(second: string, first = '`src/a.ts` (new)'): string {
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

Files:
- ${second}

Acceptance:
- [ ] it works
`;
}

function problemsOf(validator: Validator, text: string): readonly string[] {
  return validator.validate({ name: 'plan.md', text } as unknown as DocumentContent).problems;
}

const NARROW = ['src/**', 'test/**', '$STAGE_OUT/**'];

test('a task naming a path outside the write globs fails, naming the task and the path', () => {
  const problems = problemsOf(lib.implementWrites(NARROW), plan('`evals/run.py` (new)'));
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('TASK-002');
  expect(problems[0]).toContain('evals/run.py');
});

test('a plan whose paths all lie inside the write globs passes', () => {
  expect(problemsOf(lib.implementWrites(NARROW), plan('`test/a.test.ts` (new), `src/b.ts:10-20`'))).toEqual([]);
});

test('a task naming a root file with no slash or listed extension outside the write globs fails (review R6)', () => {
  const problems = problemsOf(
    lib.implementWrites(NARROW),
    plan('`.python-version`, `Dockerfile` and `pyproject.toml`'),
  );
  expect(problems).toHaveLength(3);
  expect(problems.map((problem) => problem.match(/`([^`]+)`/)?.[1])).toEqual([
    '.python-version',
    'Dockerfile',
    'pyproject.toml',
  ]);
});

test('the evals plan passes under the globs sail gives implement', () => {
  expect(problemsOf(lib.implementWrites(builderWrite), plan('`evals/run.py` (new)'))).toEqual([]);
});

test('check and derives name the validator', () => {
  const validator = lib.implementWrites(NARROW);
  expect([validator.check, validator.derives]).toEqual(['implement-writes', []]);
});

test('taskPaths agrees with the paths jev-tasks finds on the same plan', () => {
  const text = plan(
    '`src/a.ts:12`, `src/a.ts:30-40` and `bun`, `evals/x.py`, `foo.json`',
    '`test/a.test.ts`, `adapters.jev`',
  );
  expect(lib.taskPaths(text)).toEqual([
    { id: 'TASK-001', paths: ['test/a.test.ts'] },
    { id: 'TASK-002', paths: ['src/a.ts', 'evals/x.py', 'foo.json'] },
  ]);
  expect(lib.taskPaths(text)).toEqual(jev.parseTasks(text).map(({ id, paths }) => ({ id, paths })));
});

test("groom's plan stage carries the implement-writes check on plan.md", async () => {
  const { plan: stage } = (await import(
    join(ROOT, '.sail', 'workflows', 'groom', 'stages', '06-plan', 'stage.ts')
  )) as {
    plan: { produces: Record<string, { validators: Validator[] }> };
  };
  expect(stage.produces['plan.md']?.validators.map((v) => v.check)).toContain('implement-writes');
});

test("the plan stage's Question accepts a recommend that is one of its options, and rejects one that is none or an ask with no ?", async () => {
  const { Question } = (await import(join(ROOT, '.sail', 'workflows', 'groom', 'schemas.ts'))) as {
    Question: {
      safeParse(value: unknown): { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } };
    };
  };
  const question = {
    ask: 'Deny .github/?',
    options: [
      { option: 'yes', means: 'a plan naming .github/ blocks at plan' },
      { option: 'no', means: 'implement writes .github/' },
    ],
    recommend: 'no',
    why: 'review gates it',
    cites: ['.sail/lib/permissions.ts:77'],
  };
  const issues = (value: unknown) =>
    (Question.safeParse(value).error?.issues ?? []).map(({ path, message }) => `${path.join('.')}: ${message}`);
  expect({
    accepted: issues(question),
    noOption: issues({ ...question, recommend: 'maybe' }),
    noMark: issues({ ...question, ask: 'Deny .github/' }),
  }).toEqual({
    accepted: [],
    noOption: ['recommend: recommend must equal one option'],
    noMark: ['ask: ask must contain a "?"'],
  });
});
