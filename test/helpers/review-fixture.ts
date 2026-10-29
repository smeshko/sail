// Groups on the fake harness. `writeTrio()` adds `trio` to a copy of the fixture's `.sail/`: three agents `a`, `b` and
// `c` on the brief in one `run.all()`, then `d`, so a test can see what runs after a group. Each agent submits its own
// name, with orderTrio's journal gates fixing completion order and delays only spacing the calls. The fixture's own `review` workflow runs its six reviewers the same way, and
// the rest is for it: its reviewers' delays, a reviewer that ends in error, the reviewers swapped in its group, and a
// wait for a run's journal to hold so many lines.
//
// The harness script is `.sail/fake/harness.json`, read afresh by every session, so a resume in another process takes
// the delays as they are written by then.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessScript, ScriptedAnswer } from '../../src/adapters/fake/harness';
import { readJournal } from '../../src/engine/journal';
import { runWorkflow } from '../../src/engine/runtime';
import { fakeAdapters } from './adapters';
import { writeHarnessScript } from './agent-fixture';
import { copyFixture, edit, write } from './fixture';
import { copyRun } from './stub-workflow';
import { withTempRepo } from './temp-repo';

export const TRIO = 'trio';
export const TRIO_KEYS = ['a#1', 'b#1', 'c#1'];

/** The fixture's review workflow's reviewers, in the order its group declares them. */
export const REVIEWERS = ['style', 'architecture', 'side-effects', 'performance', 'security', 'coverage'];
export const REVIEW_KEYS = REVIEWERS.map((name) => `${name}#1`);
/**
 * The review run the dashboard's fixtures record in beta: the fixture's review of `FAKE-4`, on the fakes and a stepping
 * clock, its six reviewers journaled in the order they completed. It started before every other recorded run.
 */
export const FAKE_4_ID = 'FAKE-4-01M348XP801GH3GKJT2MNM2NR9';
/** The delays `harness.json` gives the reviewers, in that order: the first declared ends last. */
export const REVIEW_DELAYS = [600, 500, 400, 300, 200, 100];

const agentStage = (name: string) => `// ${name}: one of trio's agents. It reads the brief and says its name.
import { agent, file, z } from 'sail';

export const ${name} = agent('${name}', {
  prompt: './prompt.md',
  consumes: { brief: file('brief.md') },
  output: z.object({ name: z.string() }),
  model: 'default',
  permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
  budget: { maxTurns: 2, maxUsd: 1, maxMinutes: 5 },
});
`;

/** trio's group, as its workflow declares it: a test edits this line to change the group. */
export const TRIO_GROUP = '  const results = await run.all([[a, { brief }], [b, { brief }], [c, { brief }]]);\n';

const TRIO_WORKFLOW = `// trio: three agents on the brief at once, then d. It returns their names in the order the group declares them.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { a } from './stages/a/stage';
import { b } from './stages/b/stage';
import { c } from './stages/c/stage';
import { d } from './stages/d/stage';

export default workflow('${TRIO}', { intake: ticket, version: 1 }, async (run) => {
  const brief = run.intake.files['brief.md'];
${TRIO_GROUP}  const names: string[] = [];
  for (const result of results) {
    if (result.outcome === 'blocked') return run.fail(result.reason);
    names.push(result.output.name);
  }
  const last = await run.stage(d, { brief });
  return { names, last: last.outcome };
});
`;

/** What one of trio's agents submits: its name, after `delayMs`. */
const named = (name: string, delayMs: number): ScriptedAnswer => ({
  outcome: 'done',
  output: { name },
  messages: [`${name} read the brief.`],
  usage: { costUsd: 0.01 },
  delayMs,
});

/**
 * Copies the fixture's `.sail/` into `repoDir` and adds trio. `delays` gives each of a, b and c its delay in ms, and
 * `answers` replaces any agent's answers. Returns the `.sail/`.
 */
export function writeTrio(
  repoDir: string,
  delays: Record<'a' | 'b' | 'c', number>,
  answers: Partial<HarnessScript> = {},
): string {
  const sail = copyFixture(repoDir);
  for (const name of ['a', 'b', 'c', 'd']) {
    write(sail, `workflows/${TRIO}/stages/${name}/stage.ts`, agentStage(name));
    write(sail, `workflows/${TRIO}/stages/${name}/prompt.md`, `Read the brief at {{brief}}, and say your name.\n`);
  }
  write(sail, `workflows/${TRIO}/workflow.ts`, TRIO_WORKFLOW);
  const script: HarnessScript = {
    a: [named('a', delays.a)],
    b: [named('b', delays.b)],
    c: [named('c', delays.c)],
    d: [named('d', 0)],
  };
  for (const [key, given] of Object.entries(answers)) if (given !== undefined) script[key] = given;
  writeHarnessScript(repoDir, script);
  return sail;
}

/** Gates trio's done answers on the preceding call's journal line. */
export function orderTrio(repoDir: string, order: readonly ('a' | 'b' | 'c')[]): void {
  const script = harnessScript(repoDir);
  for (const [index, name] of order.entries()) {
    const previous = order[index - 1];
    script[name] = (script[name] ?? []).map((answer) =>
      answer.outcome === 'done' ? { ...answer, after: previous === undefined ? [] : [`${previous}#1`] } : answer,
    );
  }
  writeHarnessScript(repoDir, script);
}

/** What a source run of trio journals: its group in the order its calls completed, then d. */
export const TRIO_JOURNAL = ['intake#1', 'b#1', 'c#1', 'a#1', 'd#1'];

/**
 * Runs trio to its end in a repository of its own, gated to journal b, c, a. Delays of 300, 100 and 200 ms
 * for a, b and c only space the calls. Then copies that repository into `to`, where a seeded run can reuse it, and answers with the run's id and
 * the keys it journaled, for the test to check against `TRIO_JOURNAL` before it seeds.
 */
export async function trioRunInto(to: string): Promise<{ runId: string; keys: string[] }> {
  return withTempRepo(async (from) => {
    writeTrio(from.dir, { a: 300, b: 100, c: 200 });
    orderTrio(from.dir, ['b', 'c', 'a']);
    const end = await runWorkflow({
      cwd: from.dir,
      adapters: await fakeAdapters(from.dir),
      workflow: TRIO,
      ticket: 'FAKE-1',
    });
    if ('refused' in end) throw new Error(`trio was refused: ${end.refused}`);
    copyRun(from.dir, to);
    return { runId: end.runId, keys: readJournal(end.dir).entries.map((entry) => entry.key) };
  });
}

/** Copies the fixture's `.sail/` into `repoDir`: its `review` workflow and its `FAKE-1`, designated and unstarted. */
export function writeReviewFixture(repoDir: string): string {
  return copyFixture(repoDir);
}

/**
 * Takes the review workflow out of a copy of the fixture's `.sail/`, for a case about ticket-to-pr's own layout whose
 * listing would otherwise hold review's six reviewers too.
 */
export function dropReview(sail: string): void {
  rmSync(join(sail, 'workflows', 'review'), { recursive: true, force: true });
}

/** The harness script of the copy in `repoDir`. */
function harnessScript(repoDir: string): HarnessScript {
  return JSON.parse(readFileSync(join(repoDir, '.sail', 'fake', 'harness.json'), 'utf8')) as HarnessScript;
}

/** Gives each reviewer named in `delays` that delay in ms, in the copy in `repoDir`. */
export function setReviewerDelays(repoDir: string, delays: Readonly<Record<string, number>>): void {
  const script = harnessScript(repoDir);
  for (const [name, delayMs] of Object.entries(delays)) {
    const answers = script[name];
    if (answers === undefined) throw new Error(`harness.json has no answer for ${name}`);
    script[name] = answers.map((answer) => (answer.outcome === 'done' ? { ...answer, delayMs } : answer));
  }
  writeHarnessScript(repoDir, script);
}

/** The message a reviewer `failReviewer()` scripts ends in error with. */
export const REVIEWER_ERROR = 'reviewer unavailable';

/** Scripts the reviewer `name` to end in error, at once, in the copy in `repoDir`. */
export function failReviewer(repoDir: string, name: string): void {
  const script = harnessScript(repoDir);
  if (script[name] === undefined) throw new Error(`harness.json has no answer for ${name}`);
  script[name] = [{ outcome: 'error', message: REVIEWER_ERROR }];
  writeHarnessScript(repoDir, script);
}

/** The review workflow's list of reviewers, as it declares them. */
export const REVIEWER_LIST = 'const reviewers = [style, architecture, sideEffects, performance, security, coverage];';

/** Swaps the first two reviewers in the review workflow's group, in the copy `sail`: their keys change places. */
export function swapReviewers(sail: string): void {
  edit(
    sail,
    'workflows/review/workflow.ts',
    REVIEWER_LIST,
    'const reviewers = [architecture, style, sideEffects, performance, security, coverage];',
  );
}

/** How many lines the run's journal holds now, intake#1 included, or 0 before it has one. */
function journalLines(runDir: string): number {
  if (!existsSync(join(runDir, 'journal.ndjson'))) return 0;
  try {
    return readJournal(runDir).entries.length;
  } catch {
    return 0;
  }
}

/**
 * Waits until the run's journal holds at least `n` lines, looking every 20 ms, for at most `timeoutMs`. Answers whether
 * it did.
 */
export async function waitForJournaled(runDir: string, n: number, timeoutMs = 60_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (journalLines(runDir) < n) {
    if (performance.now() > deadline) return false;
    await Bun.sleep(20);
  }
  return true;
}
