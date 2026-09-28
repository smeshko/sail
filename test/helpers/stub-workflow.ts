// writeStub(): a script-only `ticket-to-pr` written into a test's temp repository. It has the fixture workflow's shape,
// spec, a fix loop of implement and tests, self-review and publish, with every stage a script, so a whole run needs no
// harness. Its tests fail until the call a threshold names, and every script logs `<stage>#<call>` to
// `.stub/executions.log`, which proves what ran.
//
// A helper, not a committed fixture: the fixture repository's agent-based `ticket-to-pr` takes over end to end once
// agents run on fakes, and what stays here are cheap edge cases a test sets up by editing its own copy. Phase 3.3 adds
// a sleep to interrupt.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { write } from './fixture';

export interface StubOptions {
  /** The first call of `tests` that passes. Earlier calls fail. Defaults to 2. */
  testsPassAt?: number;
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

/** A stub script: it logs the call it is, then runs `body`, whose last stdout line is the output. */
const shell = (purpose: string, body: string) => `#!/usr/bin/env bash
# ${purpose}
set -euo pipefail
mkdir -p "$WORKSPACE/.stub"
echo "$STAGE#$CALL" >>"$WORKSPACE/.stub/executions.log"
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
  return sail;
}

/** What the stub's scripts actually ran, one `<stage>#<call>` per line: `<repo>/.stub/executions.log`. */
export function stubExecutions(repoDir: string): string[] {
  const path = join(repoDir, '.stub', 'executions.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}
