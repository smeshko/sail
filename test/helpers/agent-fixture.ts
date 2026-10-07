// writeAgentFixture(): a copy of the fixture repository's `.sail/` in a test's temp repository, plus `brief-to-spec`: a
// script, a one-step agent stage and a script, which is what runs end to end on the fakes until intake and multi-step
// stages exist. `brief` writes the brief, `spec` turns it into a spec on the fake harness, and `publish` reads the spec.
// The fake harness's script is the test's to write: what each try of `spec#1` submits, spends and takes. The fixture's
// own `ticket-to-pr` stays as it is.
//
// The scripts log `<stage>#<call>` to `.stub/executions.log` and sleep when `.stub/sleep-at` names them, as the stub
// workflow's do, so `setSleepAt()`, `interruptWhenAsleep()`, `stubExecutions()` and `copyRun()` work here too.
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessScript, ScriptedAnswer } from '../../src/adapters/fake/harness';
import type { JournalEntry } from '../../src/engine/journal';
import { readJournal } from '../../src/engine/journal';
import { readEvents } from '../../src/events/consumers/ndjson';
import type { SailEvent } from '../../src/events/types';
import { copyFixture, write } from './fixture';

export const AGENT_WORKFLOW = 'brief-to-spec';

/** The ticket every run of the fixture is given as its input. Its title is untrusted, so the prompt wraps it. */
export const TICKET = {
  ticketKey: 'FAKE-1',
  title: 'Add a --shout flag',
  url: 'fake://tickets/FAKE-1',
  acceptanceCriteria: ['greet --shout prints the greeting in capitals'],
  labels: ['cli'],
  links: [],
  attachments: [],
};

/** `sail run` of the fixture's workflow on `TICKET`. */
export const RUN_ARGV = ['run', '--workflow', AGENT_WORKFLOW, '--input', JSON.stringify(TICKET)];

/** What `spec` submits when it is right, and the two ways the tests get it wrong. */
export const SPEC = { summary: 'Add a --shout flag to greet.', tasks: ['Add the flag', 'Cover it in tests'] };
export const NO_TASKS = { summary: 'Add a --shout flag to greet.', tasks: [] };
export const NO_SUMMARY = { tasks: ['Add the flag'] };
/** The Zod message each of them is rejected with. */
export const NO_TASKS_MESSAGE = '✖ Too small: expected array to have >=1 items\n  → at tasks';
export const NO_SUMMARY_MESSAGE = '✖ Invalid input: expected string, received undefined\n  → at summary';

type Submitted = Extract<ScriptedAnswer, { outcome: 'done' }>;

/** The usage of a session that cost `costUsd`: 8000 tokens in and 800 out per dollar, whole for any eighth of one. */
export const usageOf = (costUsd: number) => ({ inputTokens: costUsd * 8000, outputTokens: costUsd * 800, costUsd });

/** A session of `spec` that submits `output` having spent `costUsd`, and writes `spec.md` unless `extra` says otherwise. */
export const submits = (output: unknown, costUsd: number, extra: Partial<Submitted> = {}): ScriptedAnswer => ({
  outcome: 'done',
  output,
  files: { 'spec.md': '# Spec\n\n## Tasks\n' },
  messages: ['Spec written.'],
  usage: usageOf(costUsd),
  ...extra,
});

/** A stub script: it logs the call it is, sleeps if `.stub/sleep-at` names it, then runs `body`. */
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

const DIR = `workflows/${AGENT_WORKFLOW}`;

const FILES: Record<string, string> = {
  [`${DIR}/stages/brief/stage.ts`]: `// brief: writes the brief the spec step reads, for the ticket the run was given.
import { script, value, z } from 'sail';
import { TicketInput } from 'sail/intakes';

export const brief = script('brief', {
  run: './run.sh',
  consumes: { ticket: value(TicketInput) },
  produces: { 'brief.md': 'file' },
  output: z.object({ words: z.number().int() }),
});
`,
  [`${DIR}/stages/brief/run.sh`]: shell(
    'brief: a three-word brief.',
    `printf '# Brief\\n\\nAdd a flag.\\n' >"$STAGE_OUT/brief.md"
echo '{"words":3}'
`,
  ),
  [`${DIR}/stages/spec/stage.ts`]: `// spec: turns the brief into a spec, on the harness the repository configures.
import { agent, file, value, z } from 'sail';
import { TicketInput } from 'sail/intakes';

export const SpecOutput = z.object({ summary: z.string().max(400), tasks: z.array(z.string()).min(1) });

export const spec = agent('spec', {
  prompt: './prompt.md',
  consumes: { brief: file('brief.md'), ticket: value(TicketInput) },
  produces: { 'spec.md': 'file' },
  output: SpecOutput,
  model: 'deep',
  permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
  budget: { maxTurns: 4, maxUsd: 2, maxMinutes: 10 },
});
`,
  [`${DIR}/stages/spec/prompt.md`]: `Write a spec for {{ticket.ticketKey}}: {{ticket.title}}

Read the brief at {{brief}}. Write \`spec.md\`, then submit a one-sentence summary and the tasks.
`,
  [`${DIR}/stages/publish/stage.ts`]: `// publish: stands in for the pull request, and says which spec it read.
import { file, script, z } from 'sail';

export const publish = script('publish', {
  run: './run.sh',
  consumes: { spec: file('spec.md') },
  output: z.object({ published: z.boolean(), bytes: z.number().int() }),
});
`,
  [`${DIR}/stages/publish/run.sh`]: shell(
    'publish: the size of the spec it was given.',
    `echo "{\\"published\\":true,\\"bytes\\":$(wc -c <"$INPUT_SPEC" | tr -d ' ')}"
`,
  ),
  [`${DIR}/workflow.ts`]: `// brief-to-spec: a ticket in, a spec out. The agent step's blocked outcome fails the run with its reason.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { brief } from './stages/brief/stage';
import { publish } from './stages/publish/stage';
import { spec } from './stages/spec/stage';

export default workflow('${AGENT_WORKFLOW}', { intake: ticket, version: 1 }, async (run) => {
  const b = await run.stage(brief, { ticket: run.input });
  const s = await run.stage(spec, { brief: b.files['brief.md'], ticket: run.input });
  if (s.outcome === 'blocked') return run.fail(\`spec blocked: \${s.reason}\`);
  return run.stage(publish, { spec: s.files['spec.md'] });
});
`,
};

/** The workflow's call of `spec`, for a test to `edit()` into one that asks for its error. */
export const SPEC_CALL = "  const s = await run.stage(spec, { brief: b.files['brief.md'], ticket: run.input });\n";
export const SPEC_CALL_RETURNING_ERRORS = `  const s = await run.stage(spec, { brief: b.files['brief.md'], ticket: run.input }, { onError: 'return' });
  if (s.outcome === 'error') return run.fail(\`handled: \${s.reason}\`);
`;
export const WORKFLOW_FILE = `${DIR}/workflow.ts`;
export const SPEC_STAGE = `${DIR}/stages/spec`;

/** Writes the fake harness's script, `.sail/fake/harness.json`: read afresh by every session. */
export function writeHarnessScript(repoDir: string, script: HarnessScript): void {
  write(join(repoDir, '.sail'), 'fake/harness.json', `${JSON.stringify(script, null, 2)}\n`);
}

/**
 * Copies the fixture's `.sail/` into `repoDir`, adds `brief-to-spec`, and scripts the fake harness with what each try
 * of `spec` does. Returns the `.sail/`.
 */
export function writeAgentFixture(repoDir: string, spec: ScriptedAnswer[]): string {
  const sail = copyFixture(repoDir);
  for (const [path, text] of Object.entries(FILES)) {
    const file = write(sail, path, text);
    if (path.endsWith('.sh')) chmodSync(file, 0o755);
  }
  writeHarnessScript(repoDir, { spec });
  return sail;
}

/** The directory of the repository's only run. */
export function runDirIn(repoDir: string): string {
  const runs = join(repoDir, '.sail-runs');
  const [runId, ...others] = existsSync(runs) ? readdirSync(runs).filter((name) => name !== 'fake') : [];
  if (runId === undefined || others.length > 0) throw new Error(`expected one run in ${runs}`);
  return join(runs, runId);
}

/** The directory of try `tryNumber` of `spec#1` in a run: `02-spec/call-1/`, then `try-<n>/`. */
export const specDir = (runDir: string, tryNumber = 1): string =>
  join(runDir, '02-spec', 'call-1', ...(tryNumber > 1 ? [`try-${tryNumber}`] : []));

/** A file of try `tryNumber` of `spec#1`, or null when the try left none by that name. */
export function specFile(runDir: string, name: string, tryNumber = 1): string | null {
  const path = join(specDir(runDir, tryNumber), name);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** The `result.json` of try `tryNumber` of `spec#1`, or `{}` when the try left none. */
export const specResult = (runDir: string, tryNumber = 1): Record<string, unknown> =>
  JSON.parse(specFile(runDir, 'result.json', tryNumber) ?? '{}');

/** Each journaled call of a run, as `<key> <outcome>`. */
export const journaled = (runDir: string): string[] =>
  readJournal(runDir).entries.map((entry) => `${entry.key} ${entry.outcome}`);

/** The journal entry of `key`, or undefined when the run journaled no such call. */
export const entryOf = (runDir: string, key: string): JournalEntry | undefined =>
  readJournal(runDir).entries.find((entry) => entry.key === key);

/** Every session a run's events hold, as `start <id>` and `end <id> <outcome> <costUsd>`. */
export function sessions(events: readonly SailEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === 'harness:session_start') return [`start ${event.sessionId}`];
    if (event.type !== 'harness:session_end') return [];
    return [`end ${event.sessionId} ${event.outcome} ${event.usage.costUsd}`];
  });
}

/** Whether the repository's run has started `count` sessions, the last of which has reported usage. */
function inSession(repoDir: string, count: number): boolean {
  const runs = join(repoDir, '.sail-runs');
  const runId = existsSync(runs) ? readdirSync(runs).find((name) => name !== 'fake') : undefined;
  if (runId === undefined) return false;
  const events = readEvents(join(runs, runId));
  const started = events.filter((event) => event.type === 'harness:session_start').length;
  return started >= count && events.at(-1)?.type === 'usage:update';
}

/**
 * Calls `interrupt` once the repository's run is in its `count`th session, in the delay its answer scripts, and
 * returns what `running` resolves to. If `running` ends before that session starts, nothing is interrupted. It throws
 * when neither happens within `timeoutMs`.
 */
export async function interruptInSession<T>(
  repoDir: string,
  running: Promise<T>,
  interrupt: () => void,
  count = 1,
  timeoutMs = 20_000,
): Promise<T> {
  let ended = false;
  const settle = () => {
    ended = true;
  };
  running.then(settle, settle);
  const deadline = performance.now() + timeoutMs;
  while (!ended) {
    if (inSession(repoDir, count)) {
      interrupt();
      break;
    }
    if (performance.now() > deadline) {
      throw new Error(`session ${count} of the run in ${repoDir} did not start within ${timeoutMs} ms`);
    }
    await Bun.sleep(20);
  }
  return running;
}
