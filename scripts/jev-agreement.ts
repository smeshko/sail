// Measures Jev against the check agents on past runs, to set CLEAR_YES from data: `bun scripts/jev-agreement.ts <run
// directory>...`, from a repository holding the branches those runs reviewed. For each journaled `check-tasks` and
// `check-fix` call that is done, it rebuilds the state the jev-tasks and jev-fix stages ask Jev about, at the commit the
// call saw (the run's `workspace:created` base, and the head of the implement or fix call before it), asks through `sail port jev ask`, and prints per stage how Jev's answers agree with the agent's at each
// threshold, and what the calls Jev could have answered alone would have saved.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readJournal } from '../src/engine/journal';

const THRESHOLDS = [0.8, 0.85, 0.9, 0.95, 0.99];

interface Task {
  id: string;
}
interface Finding {
  id: string;
}
type Run = (args: string[]) => string;
type Answered =
  | { asked: true; answers: Record<string, { type: string; noul?: number }> }
  | { asked: false; note: string };
interface Lib {
  BASE: string;
  git: Run;
  yesses(answers: Record<string, unknown>, ids: string[]): { id: string; yes: number }[];
  askNouls(questions: object, state: object, out: string): Answered;
  parseTasks(planText: string): Task[];
  tasksState(tasks: Task[], run: Run): object;
  taskQuestions(tasks: Task[]): object;
  fixState(findings: Finding[], fixed: object, since: string, run: Run): object;
  fixQuestions(findings: Finding[]): object;
}

/** One agent call with Jev's answer for each item the agent judged. */
interface Call {
  stage: string;
  items: { id: string; agent: boolean; yes: number }[];
  costUsd: number;
  minutes: number;
}

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

function questionsAndState(lib: Lib, stage: string, inDir: string, run: Run): { questions: object; state: object } {
  if (stage === 'check-tasks') {
    const tasks = lib.parseTasks(read(inDir, 'plan.md'));
    return { questions: lib.taskQuestions(tasks), state: lib.tasksState(tasks, run) };
  }
  const { findings } = JSON.parse(read(inDir, 'findings.json')) as { findings: Finding[] };
  const fixed = JSON.parse(read(inDir, 'fixed.json')) as object;
  return {
    questions: lib.fixQuestions(findings),
    state: lib.fixState(findings, fixed, read(inDir, 'since').trim(), run),
  };
}

/** What the agent concluded per id: a task's `implemented`, a finding's `resolved`. */
function verdicts(stage: string, output: unknown): [string, boolean][] {
  if (stage === 'check-tasks') {
    const { tasks } = output as { tasks: { id: string; implemented: boolean }[] };
    return tasks.map((each) => [each.id, each.implemented]);
  }
  const { items } = output as { items: { finding: string; resolved: boolean }[] };
  return items.map((each) => [each.finding, each.resolved]);
}

/** The base the run's workspace started from: the first `workspace:created` event's. */
function baseOf(runDir: string): string | undefined {
  for (const line of read(runDir, 'events.ndjson').split('\n')) {
    if (!line.includes('"workspace:created"')) continue;
    const event = JSON.parse(line) as { type: string; baseSha?: string };
    if (event.type === 'workspace:created') return event.baseSha;
  }
  return undefined;
}

type Entry = ReturnType<typeof readJournal>['entries'][number];

/** The last non-null commit of the nearest entry before `index`, of stage `stage`, that has one. */
function headBefore(
  entries: Entry[],
  index: number,
  stage: string,
  commits: (output: unknown) => (string | null)[],
): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const entry = entries[i] as Entry;
    if (entry.stage !== stage) continue;
    const head = commits(entry.output)
      .filter((commit) => commit !== null)
      .at(-1);
    if (head !== undefined) return head;
  }
  return undefined;
}

const HEADS: Record<string, { stage: string; commits: (output: unknown) => (string | null)[]; missing: string }> = {
  'check-tasks': {
    stage: 'implement',
    commits: (output) => (output as { tasks: { commit: string | null }[] }).tasks.map((task) => task.commit),
    missing: 'no implement commit before it',
  },
  'check-fix': {
    stage: 'fix',
    commits: (output) => (output as { fixes: { commit: string | null }[] }).fixes.map((fix) => fix.commit),
    missing: 'no fix commit before it',
  },
};

export function collect(runDir: string, lib: Lib, out: string, notes: string[]): Call[] {
  const baseSha = baseOf(runDir);
  if (baseSha === undefined) {
    notes.push(`${runDir}: no workspace:created event`);
    return [];
  }
  const calls: Call[] = [];
  const { entries } = readJournal(runDir);
  for (const [index, entry] of entries.entries()) {
    if (entry.outcome !== 'done' || (entry.stage !== 'check-tasks' && entry.stage !== 'check-fix')) continue;
    const result = JSON.parse(read(runDir, entry.resultPath)) as {
      usage?: { costUsd: number };
      durationMs?: number;
    };
    const find = HEADS[entry.stage] as (typeof HEADS)[string];
    const sha = headBefore(entries, index, find.stage, find.commits);
    if (sha === undefined) {
      notes.push(`${entry.key} in ${runDir}: ${find.missing}`);
      continue;
    }
    const run: Run = (args) => lib.git(args.map((arg) => arg.replace(lib.BASE, baseSha).replace(/HEAD$/, sha)));
    let asked: Answered;
    try {
      const { questions, state } = questionsAndState(
        lib,
        entry.stage,
        join(runDir, dirname(entry.resultPath), 'in'),
        run,
      );
      asked = lib.askNouls(questions, state, out);
    } catch (error) {
      notes.push(`${entry.key} in ${runDir}: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    if (!asked.asked) {
      notes.push(`${entry.key} in ${runDir}: ${asked.note}`);
      continue;
    }
    const agents = new Map(verdicts(entry.stage, entry.output));
    const items = lib.yesses(asked.answers, [...agents.keys()]).map(({ id, yes }) => ({
      id,
      agent: agents.get(id) as boolean,
      yes,
    }));
    calls.push({
      stage: entry.stage,
      items,
      costUsd: result.usage?.costUsd ?? 0,
      minutes: (result.durationMs ?? 0) / 60_000,
    });
  }
  return calls;
}

/** The table for one stage's calls, one row per threshold. */
export function table(stage: string, calls: Call[]): string[] {
  const items = calls.flatMap((call) => call.items);
  const lines = [`${stage}: ${calls.length} calls, ${items.length} items`];
  for (const threshold of THRESHOLDS) {
    const said = (item: Call['items'][number]) => item.yes >= threshold;
    const agreed = items.filter((item) => said(item) === item.agent).length;
    const falseYes = items.filter((item) => said(item) && !item.agent).length;
    const falseNo = items.filter((item) => !said(item) && item.agent).length;
    const skippable = calls.filter((call) => call.items.length > 0 && call.items.every(said));
    const cost = skippable.reduce((sum, call) => sum + call.costUsd, 0);
    const minutes = skippable.reduce((sum, call) => sum + call.minutes, 0);
    lines.push(
      `  ${threshold.toFixed(2)}  agreement ${agreed}/${items.length}  false yeses ${falseYes}  false noes ${falseNo}  skippable ${skippable.length}/${calls.length}  saves $${cost.toFixed(2)} and ${minutes.toFixed(1)} min`,
    );
  }
  return lines;
}

async function main(runDirs: string[]): Promise<number> {
  if (runDirs.length === 0) {
    console.error('usage: bun scripts/jev-agreement.ts <run directory>...');
    return 2;
  }
  const lib = (await import(join(import.meta.dir, '..', '.sail', 'lib', 'jev-check.mjs'))) as Lib;
  const out = mkdtempSync(join(tmpdir(), 'jev-agreement-'));
  const notes: string[] = [];
  const calls = runDirs.flatMap((runDir) => collect(runDir, lib, out, notes));
  for (const stage of ['check-tasks', 'check-fix']) {
    const own = calls.filter((call) => call.stage === stage);
    if (own.length > 0) console.log(table(stage, own).join('\n'));
  }
  for (const note of notes) console.error(`skipped ${note}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
