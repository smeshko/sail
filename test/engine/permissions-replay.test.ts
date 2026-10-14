// The replay: every distinct tool call of a recorded prototype review run, sanitised into
// test/fixtures/permissions/replay.ndjson (D12), goes through decide() with its stage's permissions, and gives the
// verdict the line expects: the prototype's, or sail's where it differs on purpose, which the line's why names.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decide } from '../../src/engine/permissions/index';
import type { ToolCall } from '../../src/engine/permissions/types';
import type { Permissions } from '../../src/sdk/steps';
import { makeLayout } from '../helpers/permissions';

type Verdict = 'allow' | { readonly rule: string; readonly mentions?: string };

interface Line {
  readonly stage: string;
  readonly call: ToolCall;
  /** The verdict: allowed, or the rule, and when `mentions` is given, what the reason must name. */
  readonly expect: Verdict;
  /** Where sail decides otherwise than the prototype, or for another reason: what the prototype decided, and why. */
  readonly was?: Verdict;
  readonly why?: string;
}

const fixture = join(import.meta.dir, '..', 'fixtures', 'permissions', 'replay.ndjson');
const [first, ...rest] = readFileSync(fixture, 'utf8').trimEnd().split('\n');
const header = JSON.parse(first as string) as { calls: number; stages: Record<string, Permissions> };
const lines = rest.map((text) => JSON.parse(text) as Line);

const layout = makeLayout();
afterAll(() => layout.remove());

/** `text` with the fixture's placeholders put on this test's roots. */
function placed(text: string): string {
  return text
    .replaceAll('<worktree>', layout.worktree)
    .replaceAll('<stage-out>', layout.stageOut)
    .replaceAll('<clone>', layout.clone);
}

// Every path the calls name, created empty under the roots so directories and globs behave: a directory when another
// path lies below it, a file otherwise.
const named = [
  ...new Set(
    lines.flatMap((line) =>
      line.call.paths.map((path) => (path.startsWith('<') ? placed(path) : join(layout.worktree, path))),
    ),
  ),
];
for (const path of named) {
  if (named.some((other) => other.startsWith(`${path}/`))) mkdirSync(path, { recursive: true });
}
for (const path of named) {
  if (named.some((other) => other.startsWith(`${path}/`))) continue;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
}

/** A line's call on this test's roots. */
function callOf(line: Line): ToolCall {
  return {
    ...line.call,
    paths: line.call.paths.map(placed),
    ...(line.call.command === undefined ? {} : { command: placed(line.call.command) }),
    ...(line.call.cwd === undefined ? {} : { cwd: placed(line.call.cwd) }),
  };
}

/** The verdict decide() gives a line, in the line's terms: the reason checked for what the line says it mentions. */
function verdictOf(line: Line): Verdict {
  const permissions = header.stages[line.stage] as Permissions;
  const decision = decide(callOf(line), permissions, layout.ctx);
  if (decision.allow) return 'allow';
  const mentions = line.expect === 'allow' ? undefined : line.expect.mentions;
  if (mentions === undefined) return { rule: decision.rule };
  return { rule: decision.rule, mentions: decision.reason.includes(mentions) ? mentions : decision.reason };
}

// biome-ignore format: TDD-PENDING TASK-009
test
  .skip // TDD-PENDING TASK-009
  ('every distinct recorded call gets the verdict its line expects; where sail differs, the line says why', () => {
  expect(lines.length).toBe(header.calls);
  const unexplained = lines.filter(
    (line) => header.stages[line.stage] === undefined || (line.was === undefined) !== (line.why === undefined),
  );
  expect(unexplained).toEqual([]);
  const verdicts = lines.map(verdictOf);
  const mismatches = lines.flatMap((line, i) =>
    JSON.stringify(verdicts[i]) === JSON.stringify(line.expect)
      ? []
      : [
          `${line.stage} ${line.call.kind} ${line.call.command ?? line.call.paths.join(' ')}: got ${JSON.stringify(verdicts[i])}`,
        ],
  );
  const allowed = verdicts.filter((verdict) => verdict === 'allow').length;
  const summary = `${lines.length} calls: ${allowed} allowed, ${lines.length - allowed} denied, ${mismatches.length} differ`;
  expect(mismatches.length === 0 ? [] : [summary, ...mismatches]).toEqual([]);
});

// biome-ignore format: TDD-PENDING TASK-009
test
  .skip // TDD-PENDING TASK-009
  ("verdict-fix's write to the merge agent's config is a write denial, as the prototype refused it", () => {
  const merge = lines.filter(
    (line) =>
      line.stage === 'verdict-fix' &&
      line.call.kind !== 'read' &&
      line.call.paths.some((path) => path.endsWith('/pr-merge-agent.json')),
  );
  expect(merge.map((line) => [line.call.kind, line.expect, verdictOf(line)])).toEqual([
    ['edit', { rule: 'write', mentions: 'pr-merge-agent.json' }, { rule: 'write', mentions: 'pr-merge-agent.json' }],
  ]);
});
