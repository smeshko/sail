// writeTwoStep(): the agent fixture's `brief-to-spec` with a multi-step stage, for the runtime's cases. Its `publish`
// is the fixture's shape, two steps: an agent `describe` that writes the pull request's body on the fake harness, then
// a script `open` that reads describe's title and that body. A `notify` script follows it, so a run can be seeded
// after it, and `grouped` puts the two in one `run.all()` group instead. `open` and `notify` log `<stage>#<call>` to
// `.stub/executions.log` and sleep when `.stub/sleep-at` names them, as the agent fixture's scripts do.
import { chmodSync } from 'node:fs';
import type { ScriptedAnswer } from '../../src/adapters/fake/harness';
import type { SailEvent } from '../../src/events/types';
import { AGENT_WORKFLOW, SPEC, submits, WORKFLOW_FILE, writeAgentFixture, writeHarnessScript } from './agent-fixture';
import { write } from './fixture';

/** What `describe` submits when it is right. */
export const PR_TITLE = 'Add a --shout flag (FAKE-1)';
export const PR_BODY = '## Summary\n\nAdds --shout.\n';
export const DESCRIBED: ScriptedAnswer = {
  outcome: 'done',
  output: { title: PR_TITLE, bodyFile: 'pr-body.md' },
  files: { 'pr-body.md': PR_BODY },
  messages: ['Described.'],
  usage: { inputTokens: 800, outputTokens: 80, costUsd: 0.25 },
};

/** `brief-to-spec`'s stage directory of `publish`, under `.sail/`. */
export const PUBLISH_STAGE = `workflows/${AGENT_WORKFLOW}/stages/publish`;
/** `publish`'s directory in a run: the fourth stage, after the intake's `00`, then brief, spec and publish. */
export const PUBLISH_CALL = '03-publish/call-1';

const shell = (purpose: string, body: string) => `#!/usr/bin/env bash
# ${purpose}
set -euo pipefail
STUB="$(dirname "$(dirname "$SAIL_CONFIG")")/.stub"
mkdir -p "$STUB"
echo "$STAGE#$CALL" >>"$STUB/executions.log"
if [ -f "$STUB/sleep-at" ] && [ "$(cat "$STUB/sleep-at")" = "$STAGE#$CALL" ]; then
  rm "$STUB/sleep-at"
  sleep 30 &
  echo "$$ $!" >"$STUB/sleeping.tmp"
  mv "$STUB/sleeping.tmp" "$STUB/sleeping"
  wait
fi
${body}`;

const FILES: Record<string, string> = {
  [`${PUBLISH_STAGE}/stage.ts`]: `// publish: describes the change, then opens the pull request. Its outcome is the open step's.
import { agent, file, fromStep, script, stage, z } from 'sail';

export const PrDescription = z.object({ title: z.string().max(120), bodyFile: z.string() });
export const PrInfo = z.object({ number: z.number().int(), url: z.string() });

const describe = agent('describe', {
  prompt: './describe.md',
  consumes: { spec: file('spec.md') },
  produces: { 'pr-body.md': 'file' },
  output: PrDescription,
  model: 'default',
  permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
  budget: { maxTurns: 4, maxUsd: 1, maxMinutes: 5 },
});

const open = script('open', {
  run: './open.sh',
  consumes: { title: fromStep('describe').output('title'), body: fromStep('describe').file('pr-body.md') },
  output: PrInfo,
});

export const publish = stage('publish', { consumes: { spec: file('spec.md') }, output: PrInfo, steps: [describe, open] });
`,
  [`${PUBLISH_STAGE}/describe.md`]: 'Describe the change in {{spec}} for its pull request.\n',
  [`${PUBLISH_STAGE}/open.sh`]: shell(
    'open: pull request 3, for the title describe gave.',
    `echo '{"number":3,"url":"fake://codehost/pull/3"}'
`,
  ),
  [`workflows/${AGENT_WORKFLOW}/stages/notify/stage.ts`]: `// notify: says where the pull request is.
import { script, value, z } from 'sail';

export const notify = script('notify', {
  run: './run.sh',
  consumes: { url: value(z.string()) },
  output: z.object({ sent: z.boolean() }),
});
`,
  [`workflows/${AGENT_WORKFLOW}/stages/notify/run.sh`]: shell(
    'notify: sent.',
    `echo '{"sent":true}'
`,
  ),
};

const SEQUENCE = `// brief-to-spec, with publish a stage of two steps, then notify.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { brief } from './stages/brief/stage';
import { notify } from './stages/notify/stage';
import { publish } from './stages/publish/stage';
import { spec } from './stages/spec/stage';

export default workflow('${AGENT_WORKFLOW}', { intake: ticket, version: 1 }, async (run) => {
  const b = await run.stage(brief, { ticket: run.input });
  const s = await run.stage(spec, { brief: b.files['brief.md'], ticket: run.input });
  if (s.outcome === 'blocked') return run.fail(\`spec blocked: \${s.reason}\`);
  const p = await run.stage(publish, { spec: s.files['spec.md'] });
  if (p.outcome !== 'passed') return run.fail(\`publish \${p.outcome}\`);
  return run.stage(notify, { url: p.output.url });
});
`;

const GROUPED = `// brief-to-spec, with publish, a stage of two steps, and notify in one group.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { brief } from './stages/brief/stage';
import { notify } from './stages/notify/stage';
import { publish } from './stages/publish/stage';
import { spec } from './stages/spec/stage';

export default workflow('${AGENT_WORKFLOW}', { intake: ticket, version: 1 }, async (run) => {
  const b = await run.stage(brief, { ticket: run.input });
  const s = await run.stage(spec, { brief: b.files['brief.md'], ticket: run.input });
  if (s.outcome === 'blocked') return run.fail(\`spec blocked: \${s.reason}\`);
  const [p, n] = await run.all([
    [publish, { spec: s.files['spec.md'] }],
    [notify, { url: 'fake://codehost/pull/0' }],
  ]);
  return { publish: p.outcome, notify: n.outcome };
});
`;

/** The grouped workflow's group, as written: for a test to swap its calls. */
export const GROUP_CALLS = `    [publish, { spec: s.files['spec.md'] }],
    [notify, { url: 'fake://codehost/pull/0' }],
`;

export interface TwoStepOptions {
  /** What each try of `describe` does. */
  describe?: ScriptedAnswer[];
  /** Puts publish and notify in one group. */
  grouped?: boolean;
}

/** Writes the agent fixture into `repoDir` with publish of two steps, then notify. Returns the `.sail/`. */
export function writeTwoStep(repoDir: string, options: TwoStepOptions = {}): string {
  const sail = writeAgentFixture(repoDir, [submits(SPEC, 0.5)]);
  for (const [path, text] of Object.entries(FILES)) {
    const file = write(sail, path, text);
    if (path.endsWith('.sh')) chmodSync(file, 0o755);
  }
  write(sail, WORKFLOW_FILE, options.grouped ? GROUPED : SEQUENCE);
  writeHarnessScript(repoDir, { spec: [submits(SPEC, 0.5)], 'publish/describe': options.describe ?? [DESCRIBED] });
  return sail;
}

/** The sessions the events hold for `key`, by their starts. */
export const sessionsOf = (events: readonly SailEvent[], key: string): number =>
  events.filter((event) => event.type === 'harness:session_start' && 'key' in event && event.key === key).length;
