// Declaration-level type cases: what agent(), script() and stage() refuse. test/types/expect-error.test.ts proves
// that each directive's line fails with the code it names. Cases import only from `sail`, because the harness checks
// a copy of this file in a temp directory.
import { agent, file, gitDiff, intake, type OutcomeOf, type ScriptOutcome, script, stage, z } from 'sail';

const Output = z.object({ ok: z.boolean() });
const permissions = { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] };
const budget = { maxTurns: 10, maxUsd: 1, maxMinutes: 5 };

// @ts-expect-error TS2741: an agent step must declare its permissions
agent('no-permissions', { prompt: './prompt.md', output: Output, budget });

// @ts-expect-error TS2741: an agent step must declare its budget
agent('no-budget', { prompt: './prompt.md', output: Output, permissions });

agent('with-tools', {
  prompt: './prompt.md',
  output: Output,
  permissions: { ...permissions, tools: ['WebFetch', 'linear:get_issue', 'github:*'] },
  budget,
});

agent('one-tool', {
  prompt: './prompt.md',
  output: Output,
  // @ts-expect-error TS2322: a step lists its tools, so one name is not enough
  permissions: { ...permissions, tools: 'WebFetch' },
  budget,
});

agent('raw-schema', {
  prompt: './prompt.md',
  // @ts-expect-error TS2322: a schema is not a binding until value() wraps it
  consumes: { report: Output },
  output: Output,
  permissions,
  budget,
});

stage('no-steps', {
  output: Output,
  // @ts-expect-error TS2322: a stage has at least one step
  steps: [],
});

stage('mismatched-output', {
  output: z.object({ url: z.string() }),
  // @ts-expect-error TS2322: a stage's output is its last step's, and this step's has no url
  steps: [script('open', { run: './open.sh', output: Output })],
});

// The workflow supplies a stage's bindings, so a stage declares each one its steps take from the workflow.
const implement = agent('implement', {
  prompt: './prompt.md',
  consumes: { spec: file('spec.md'), diff: gitDiff('origin/main...HEAD') },
  output: Output,
  permissions,
  budget,
});
stage('covered', { consumes: { spec: file('spec.md') }, output: Output, steps: [implement] });

// @ts-expect-error TS2345: implement takes spec from the workflow, and the stage declares no bindings
stage('uncovered', { output: Output, steps: [implement] });

stage('elsewhere', {
  // @ts-expect-error TS2322: implement takes spec from the workflow, and the stage declares only brief
  consumes: { brief: file('brief.md') },
  output: Output,
  steps: [implement],
});

stage('optional-spec', {
  // @ts-expect-error TS2322: implement requires spec, so the stage can't leave it optional
  consumes: { spec: file('spec.md').optional() },
  output: Output,
  steps: [implement],
});

intake('mismatched-intake', {
  accepts: ['ticket'],
  output: z.object({ ticketKey: z.string() }),
  // @ts-expect-error TS2322: an intake's input is its last step's output, and this step's has no ticketKey
  steps: [script('fetch', { run: './fetch.sh', output: Output })],
});

const describe = agent('describe', { prompt: './describe.md', output: Output, permissions, budget });
const open = script('open', { run: './open.sh', output: Output });
const publish = stage('publish', { output: Output, steps: [describe, open] });

// A stage's outcome is its last step's, or the one an earlier step stopped it with: this one ends in a script, after an
// agent that may block, so it passes, fails or is blocked, and is never done.
declare const outcome: OutcomeOf<typeof publish>;
export const settled: ScriptOutcome | 'blocked' = outcome;
// @ts-expect-error TS2367: a stage that ends in a script step can't end done
export const done = outcome === 'done';

// Documents: only an agent step completes one, from its template, checked by validators a repository may write.
import { countItems, doc, hasSections, noPlaceholders, type Validator } from 'sail';

const words: Validator = {
  check: 'words',
  derives: ['words'],
  validate: (document) => ({ problems: [], derived: { words: document.text.split(/\s+/).length } }),
};
agent('documented', {
  prompt: './prompt.md',
  produces: {
    'spec.md': doc('./templates/spec.md', [hasSections('Tasks'), noPlaceholders(), countItems('Tasks'), words]),
    'notes.md': 'file',
  },
  output: Output,
  permissions,
  budget,
});

script('documented-script', {
  run: './run.sh',
  // @ts-expect-error TS2322: a script step produces files, not documents
  produces: { 'report.md': doc('./templates/report.md') },
  output: Output,
});

intake('documented-intake', {
  accepts: ['ticket'],
  output: Output,
  // @ts-expect-error TS2322: an intake produces files, not documents
  produces: { 'brief.md': doc('./templates/brief.md') },
  steps: [script('fetch', { run: './fetch.sh', output: Output })],
});

// @ts-expect-error TS2741: a validator must say how it validates
doc('./templates/spec.md', [{ check: 'empty', derives: [] }]);

// @ts-expect-error TS2554: countItems counts the items of a section it names
countItems();
