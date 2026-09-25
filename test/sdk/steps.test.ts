import { expect, test } from 'bun:test';
import { agent, file, script, stage, value, z } from '../../src/sdk/index';

const Output = z.object({ ok: z.boolean() });
const permissions = { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git diff *'] };
const budget = { maxTurns: 10, maxUsd: 1, maxMinutes: 5 };

test('agent() returns its options as given, under kind and name', () => {
  const consumes = { brief: file('brief.md'), feedback: value(Output).optional() };
  const step = agent('spec', {
    prompt: './prompt.md',
    consumes,
    produces: { 'spec.md': 'file' },
    output: Output,
    model: 'deep',
    permissions,
    budget,
    onInvalidOutput: 'fail',
  });
  expect(step).toEqual({
    kind: 'agent',
    name: 'spec',
    prompt: './prompt.md',
    consumes,
    produces: { 'spec.md': 'file' },
    output: Output,
    model: 'deep',
    permissions,
    budget,
    onInvalidOutput: 'fail',
  });
});

test('agent() defaults absent consumes and produces to empty objects, and nothing else', () => {
  const step = agent('describe', { prompt: './describe.md', output: Output, permissions, budget });
  expect(step).toEqual({
    kind: 'agent',
    name: 'describe',
    prompt: './describe.md',
    consumes: {},
    produces: {},
    output: Output,
    permissions,
    budget,
  });
  expect(step).not.toHaveProperty('model');
  expect(step).not.toHaveProperty('onInvalidOutput');
});

test('script() returns its options as given, under kind and name', () => {
  const step = script('tests', {
    run: './run.sh',
    produces: { 'junit.xml': 'file' },
    output: Output,
    exitCodes: { passed: [0], failed: [1] },
    timeoutSeconds: 900,
    network: ['registry.npmjs.org'],
  });
  expect(step).toEqual({
    kind: 'script',
    name: 'tests',
    run: './run.sh',
    consumes: {},
    produces: { 'junit.xml': 'file' },
    output: Output,
    exitCodes: { passed: [0], failed: [1] },
    timeoutSeconds: 900,
    network: ['registry.npmjs.org'],
  });
});

test('script() defaults absent consumes and produces, and leaves the exit codes to the engine', () => {
  const step = script('open', { run: './open.sh', output: Output });
  expect(step).toEqual({ kind: 'script', name: 'open', run: './open.sh', consumes: {}, produces: {}, output: Output });
  expect(step).not.toHaveProperty('exitCodes');
});

test('stage() keeps its steps in order and has no guardrails of its own', () => {
  const describe = agent('describe', { prompt: './describe.md', output: Output, permissions, budget });
  const open = script('open', { run: './open.sh', output: Output });
  const consumes = { spec: file('spec.md') };
  const publish = stage('publish', { consumes, output: Output, steps: [describe, open] });
  expect(publish).toEqual({
    kind: 'stage',
    name: 'publish',
    consumes,
    produces: {},
    output: Output,
    steps: [describe, open],
  });
  expect(publish.steps[1]).toBe(open);
  expect(publish).not.toHaveProperty('permissions');
  expect(publish).not.toHaveProperty('budget');
});

test('stage() keeps produces as given', () => {
  const only = script('only', { run: './run.sh', output: Output });
  expect(stage('one', { produces: { 'out.md': 'file' }, output: Output, steps: [only] }).produces).toEqual({
    'out.md': 'file',
  });
});

test("stage() refuses an output that only looks like its last step's, because types can't see refinements", () => {
  const open = script('open', { run: './open.sh', output: z.object({ url: z.string() }) });
  expect(() => stage('publish', { output: z.object({ url: z.url() }), steps: [open] })).toThrow(
    "stage 'publish': its output must be the schema its last step 'open' declares",
  );
});

test('stage() refuses a value binding whose schema only looks like the one its step takes', () => {
  const Email = z.email();
  const notify = script('notify', { run: './notify.sh', consumes: { to: value(Email) }, output: Output });
  expect(() => stage('announce', { consumes: { to: value(z.string()) }, output: Output, steps: [notify] })).toThrow(
    "stage 'announce': binding 'to' must use the schema step 'notify' declares for it",
  );
  expect(
    stage('announce', { consumes: { to: value(Email) }, output: Output, steps: [notify] }).consumes.to.schema,
  ).toBe(Email);
});
