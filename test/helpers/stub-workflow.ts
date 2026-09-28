// writeStub(): a script-only `ticket-to-pr` written into a test's temp repository. It has the fixture workflow's shape,
// spec, a fix loop of implement and tests, self-review and publish, with every stage a script, so a whole run needs no
// harness. Its tests fail until the call a threshold names, and every script logs `<stage>#<call>` to
// `.stub/executions.log`, which proves what ran.
//
// `sleepAt` names a call that sleeps the first time it runs, until something stops its process group. The sleeping
// script writes its own pid and its `sleep`'s to `.stub/sleeping`, so a test can interrupt it there and check that
// neither process survives.
//
// A helper, not a committed fixture: the fixture repository's agent-based `ticket-to-pr` takes over end to end once
// agents run on fakes, and what stays here are cheap edge cases a test sets up by editing its own copy.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { edit, write } from './fixture';

export interface StubOptions {
  /** The first call of `tests` that passes. Earlier calls fail. Defaults to 2. */
  testsPassAt?: number;
  /** The key of the call that sleeps the first time it runs, such as `implement#2`, for a test to interrupt. */
  sleepAt?: string;
}

const PROJECT = `# The stub repository's config: every port on its fake adapter.
name: stub
sail: ">=0.0.0 <1"
label: sail
defaultWorkflow: ticket-to-pr
adapters:
  ticketSource: { use: fake }
  codeHost: { use: fake }
  harness: { use: fake }
  workspace: { use: fake }
models: { default: claude-sonnet-5, deep: claude-opus-5-5 }
budgets: { run: { maxUsd: 25, maxMinutes: 90 } }
`;

/**
 * A stub script: it logs the call it is, sleeps if `.stub/sleep-at` names it, then runs `body`, whose last stdout line is
 * the output. The marker is removed before the sleep, so the call's next try runs through. `.stub/sleeping` is written
 * whole, by a rename, so a poller never reads half of it.
 */
const shell = (purpose: string, body: string) => `#!/usr/bin/env bash
# ${purpose}
set -euo pipefail
mkdir -p "$WORKSPACE/.stub"
echo "$STAGE#$CALL" >>"$WORKSPACE/.stub/executions.log"
if [ -f "$WORKSPACE/.stub/sleep-at" ] && [ "$(cat "$WORKSPACE/.stub/sleep-at")" = "$STAGE#$CALL" ]; then
  rm "$WORKSPACE/.stub/sleep-at"
  sleep 30 &
  echo "$$ $!" >"$WORKSPACE/.stub/sleeping.tmp"
  mv "$WORKSPACE/.stub/sleeping.tmp" "$WORKSPACE/.stub/sleeping"
  wait
fi
${body}`;

const FILES: Record<string, string> = {
  'stages/tests/stage.ts': `// tests: the stub's test run. It fails until the call .stub/tests-pass-at names, 2 unless set.
import { script, z } from 'sail';

export const TestReport = z.object({
  ok: z.boolean(),
  total: z.number().int(),
  failed: z.number().int(),
  durationMs: z.number().int(),
  failures: z.array(z.object({ test: z.string(), file: z.string(), message: z.string() })),
});

export const tests = script('tests', {
  run: './run.sh',
  produces: { 'junit.xml': 'file' },
  output: TestReport,
  exitCodes: { passed: [0], failed: [1] },
});
`,
  'stages/tests/run.sh': shell(
    'The stub tests: a failing report while $CALL is below the threshold, then a passing one.',
    `pass_at=2
if [ -f "$WORKSPACE/.stub/tests-pass-at" ]; then pass_at=$(cat "$WORKSPACE/.stub/tests-pass-at"); fi
if [ "$CALL" -lt "$pass_at" ]; then
  echo '<testsuites tests="1" failures="1"/>' >"$STAGE_OUT/junit.xml"
  echo '{"ok":false,"total":1,"failed":1,"durationMs":0,"failures":[{"test":"greets","file":"test/greet.test.ts","message":"expected a greeting"}]}'
  exit 1
fi
echo '<testsuites tests="1" failures="0"/>' >"$STAGE_OUT/junit.xml"
echo '{"ok":true,"total":1,"failed":0,"durationMs":0,"failures":[]}'
`,
  ),
  'stages/implement/stage.ts': `// implement: the stub's change. Its output says whether the last pass's feedback reached it.
import { file, script, value, z } from 'sail';
import { TestReport } from '../tests/stage';

/** One thing a review found in the change. */
export const Finding = z.object({
  severity: z.enum(['high', 'medium', 'low', 'nit']),
  file: z.string(),
  title: z.string(),
  detail: z.string(),
});

/** What a failed pass of the fix loop carries back: the failing test report, or the findings that must be fixed. */
export const Feedback = z.union([TestReport, z.object({ findings: z.array(Finding) })]);

export const Change = z.object({ notes: z.string(), sawFeedback: z.boolean() });

export const implement = script('implement', {
  run: './run.sh',
  consumes: { spec: file('spec.md'), feedback: value(Feedback).optional() },
  produces: { 'diff.patch': 'file' },
  output: Change,
});
`,
  'stages/implement/run.sh': shell(
    'The stub implement: a one-line patch, and whether feedback was bound.',
    `echo 'diff --git a/src/greet.ts b/src/greet.ts' >"$STAGE_OUT/diff.patch"
if [ -n "\${INPUT_FEEDBACK:-}" ]; then saw=true; else saw=false; fi
echo "{\\"notes\\":\\"a stub change\\",\\"sawFeedback\\":$saw}"
`,
  ),
  'workflows/ticket-to-pr/stages/spec/stage.ts': `// spec: the stub's spec. It consumes nothing: intake leaves no files until it exists.
import { script, z } from 'sail';

export const SpecOutput = z.object({
  summary: z.string().max(400),
  tasks: z.array(z.object({ title: z.string(), files: z.array(z.string()) })).min(1),
});

export const spec = script('spec', { run: './run.sh', produces: { 'spec.md': 'file' }, output: SpecOutput });
`,
  'workflows/ticket-to-pr/stages/spec/run.sh': shell(
    'The stub spec: a one-task spec.',
    `printf '# Spec\\n\\nAdd a greeting.\\n' >"$STAGE_OUT/spec.md"
echo '{"summary":"Add a greeting.","tasks":[{"title":"Add greet()","files":["src/greet.ts"]}]}'
`,
  ),
  'workflows/ticket-to-pr/stages/self-review/stage.ts': `// self-review: the stub's review. It never finds anything that must be fixed.
import { file, script, z } from 'sail';
import { Finding } from '../../../../stages/implement/stage';

export const ReviewOutput = z.object({ summary: z.string(), findings: z.array(Finding) });

export const selfReview = script('self-review', {
  run: './run.sh',
  consumes: { spec: file('spec.md') },
  output: ReviewOutput,
});
`,
  'workflows/ticket-to-pr/stages/self-review/run.sh': shell(
    'The stub self-review: no findings.',
    `echo '{"summary":"Nothing to fix.","findings":[]}'
`,
  ),
  'workflows/ticket-to-pr/stages/publish/stage.ts': `// publish: the stub's pull request, on the fake code host.
import { file, script, z } from 'sail';

export const PrInfo = z.object({ number: z.number().int(), url: z.string(), draft: z.boolean() });

export const publish = script('publish', { run: './run.sh', consumes: { spec: file('spec.md') }, output: PrInfo });
`,
  'workflows/ticket-to-pr/stages/publish/run.sh': shell(
    'The stub publish: pull request 1 on the fake code host.',
    `echo '{"number":1,"url":"fake://codehost/stub/pull/1","draft":false}'
`,
  ),
  'workflows/ticket-to-pr/workflow.ts': `// ticket-to-pr, as a stub: the fixture's workflow with every stage a script, so its routing is on passed and failed.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { Feedback, implement } from '../../stages/implement/stage';
import { tests } from '../../stages/tests/stage';
import { publish } from './stages/publish/stage';
import { selfReview } from './stages/self-review/stage';
import { spec } from './stages/spec/stage';

export default workflow('ticket-to-pr', { intake: ticket, version: 1 }, async (run) => {
  const s = await run.stage(spec);
  if (s.outcome === 'failed') return run.fail('spec failed');

  // Failing tests, then must-fix findings, go back to implement as the next pass's feedback.
  for (const iteration of run.loop('fix', { max: 3, feedback: Feedback })) {
    const impl = await run.stage(implement, { spec: s.files['spec.md'], feedback: iteration.previous });
    if (impl.outcome === 'failed') return run.fail('implement failed');
    const t = await run.stage(tests);
    if (t.outcome === 'failed') {
      iteration.fail(t.output);
      continue;
    }
    const r = await run.stage(selfReview, { spec: s.files['spec.md'] });
    const findings = r.output.findings.filter((finding) => finding.severity === 'high');
    if (findings.length === 0) break;
    iteration.fail({ findings });
  }

  return run.stage(publish, { spec: s.files['spec.md'] });
});
`,
};

const IMPLEMENT_THEN_TESTS = `    const impl = await run.stage(implement, { spec: s.files['spec.md'], feedback: iteration.previous });
    if (impl.outcome === 'failed') return run.fail('implement failed');
    const t = await run.stage(tests);
`;
const TESTS_THEN_IMPLEMENT = `    const t = await run.stage(tests);
    const impl = await run.stage(implement, { spec: s.files['spec.md'], feedback: iteration.previous });
    if (impl.outcome === 'failed') return run.fail('implement failed');
`;

/**
 * Moves the fix loop's tests call above its implement call in the stub's `.sail/`. The workflow still type-checks, but
 * its keys no longer fit a journal that has `implement#1` second.
 */
export function swapImplementAndTests(sail: string): void {
  edit(sail, 'workflows/ticket-to-pr/workflow.ts', IMPLEMENT_THEN_TESTS, TESTS_THEN_IMPLEMENT);
}

/** Writes the stub `.sail/` into `repoDir` and returns it. */
export function writeStub(repoDir: string, options: StubOptions = {}): string {
  const sail = join(repoDir, '.sail');
  write(sail, 'project.yaml', PROJECT);
  for (const [path, text] of Object.entries(FILES)) {
    const file = write(sail, path, text);
    if (path.endsWith('.sh')) chmodSync(file, 0o755);
  }
  if (options.testsPassAt !== undefined) {
    mkdirSync(join(repoDir, '.stub'), { recursive: true });
    writeFileSync(join(repoDir, '.stub', 'tests-pass-at'), `${options.testsPassAt}\n`);
  }
  if (options.sleepAt !== undefined) setSleepAt(repoDir, options.sleepAt);
  return sail;
}

/** Makes the call `key` sleep the next time it runs, and clears the `.stub/sleeping` an earlier sleep left. */
export function setSleepAt(repoDir: string, key: string): void {
  mkdirSync(join(repoDir, '.stub'), { recursive: true });
  writeFileSync(join(repoDir, '.stub', 'sleep-at'), `${key}\n`);
  rmSync(join(repoDir, '.stub', 'sleeping'), { force: true });
}

/** The pids of the sleeping script and its `sleep`, from `<repo>/.stub/sleeping`, or undefined until it exists. */
export function sleepingPids(repoDir: string): number[] | undefined {
  const path = join(repoDir, '.stub', 'sleeping');
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8').trim().split(' ').map(Number);
}

/** Waits for the call `sleepAt` names to fall asleep, and returns its pids. It throws, naming the file, after `timeoutMs`. */
export async function whenSleeping(repoDir: string, timeoutMs = 10_000): Promise<number[]> {
  const deadline = performance.now() + timeoutMs;
  let pids = sleepingPids(repoDir);
  while (pids === undefined) {
    if (performance.now() > deadline) {
      throw new Error(`${join(repoDir, '.stub', 'sleeping')} did not appear within ${timeoutMs} ms`);
    }
    await Bun.sleep(20);
    pids = sleepingPids(repoDir);
  }
  return pids;
}

/** Whether a process with this pid exists: signal 0 checks without sending anything. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** How long an interrupted run may take to end: the grace period between SIGTERM and SIGKILL. */
const STOP_MS = 5_000;

/**
 * Interrupts `running` once the call `sleepAt` names is asleep, and returns what `running` resolves to with the pids of
 * the sleeping processes still `alive` at that moment. If `running` ends before anything sleeps, nothing is interrupted.
 * If it hasn't ended `STOP_MS` after the interrupt, the interrupt didn't stop it: the sleepers are killed so it can end,
 * and all of them count as alive. Either way no sleeper outlives the call, so a failing test leaves none behind.
 */
export async function interruptWhenAsleep<T>(
  repoDir: string,
  running: Promise<T>,
  interrupt: () => void,
  timeoutMs = 10_000,
): Promise<{ end: T; alive: number[] }> {
  let ended = false;
  const settled = running.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    },
  );
  const deadline = performance.now() + timeoutMs;
  let pids = sleepingPids(repoDir);
  while (pids === undefined && !ended) {
    if (performance.now() > deadline) {
      throw new Error(`${join(repoDir, '.stub', 'sleeping')} did not appear within ${timeoutMs} ms`);
    }
    await Bun.sleep(20);
    pids = sleepingPids(repoDir);
  }
  if (pids === undefined) return { end: await running, alive: [] };

  interrupt();
  const stopped = await Promise.race([settled.then(() => true), Bun.sleep(STOP_MS).then(() => false)]);
  const alive = stopped ? pids.filter(isAlive) : pids;
  for (const pid of alive) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  return { end: await running, alive };
}

/**
 * Copies a repository's `.sail/`, `.sail-runs/` and, when it exists, `.stub/` into `to`, so a run can resume there: a
 * fresh `.sail/` path gets a claim and modules of its own. Paths in a run directory are relative, so the copy resumes
 * as the original would.
 */
export function copyRun(from: string, to: string): void {
  for (const name of ['.sail', '.sail-runs', '.stub']) {
    if (existsSync(join(from, name))) cpSync(join(from, name), join(to, name), { recursive: true });
  }
}

/** What the stub's scripts actually ran, one `<stage>#<call>` per line: `<repo>/.stub/executions.log`. */
export function stubExecutions(repoDir: string): string[] {
  const path = join(repoDir, '.stub', 'executions.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}
