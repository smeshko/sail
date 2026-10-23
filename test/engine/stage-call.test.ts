// A multi-step stage's call, with no run around it: runStageCall() on the fake harness and stub scripts in a temporary
// repository, each step's result.json and the stage's read back from disk. `publish` is the fixture's shape: an agent
// `describe` that writes the pull request's body, then a script `open` that reads its title and that body.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeHarness, type ScriptedAnswer } from '../../src/adapters/fake/harness';
import type { Supplied } from '../../src/engine/bindings';
import { type CallRequest, callProblems, runCall } from '../../src/engine/call';
import type { JournalEntry } from '../../src/engine/journal';
import { formatIssue, validateDocument, validateRunDir } from '../../src/engine/schemas';
import { runStageCall, type StageHooks } from '../../src/engine/stage-call';
import type { NewEvent } from '../../src/events/types';
import { agent, fromStep, gitDiff, type Stage, script, stage, value, z } from '../../src/sdk/index';
import { type Recorded, recording } from '../helpers/scripted-harness';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const RUN_ID = 'publish-01ARYZ6S410000000000000000';
const TS = '2026-10-23T09:00:00.000Z';
const MODEL = 'claude-sonnet-5';
const permissions = { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git log *'] };
const budget = { maxTurns: 10, maxUsd: 1, maxMinutes: 5 };

const PrDescription = z.object({ title: z.string().max(120), bodyFile: z.string() });
const PrInfo = z.object({ number: z.number().int(), url: z.string() });
const LintReport = z.object({ problems: z.array(z.string()) });
const TicketKey = z.string();

const describe = agent('describe', {
  prompt: './describe.md',
  consumes: { ticketKey: value(TicketKey) },
  produces: { 'pr-body.md': 'file' },
  output: PrDescription,
  model: 'default',
  permissions,
  budget,
});
const open = script('open', {
  run: './open.sh',
  consumes: {
    title: fromStep('describe').output('title'),
    body: fromStep('describe').file('pr-body.md'),
    ticketKey: value(TicketKey),
  },
  output: PrInfo,
  exitCodes: { passed: [0], failed: [] },
});
const publish = stage('publish', {
  consumes: { ticketKey: value(TicketKey) },
  output: PrInfo,
  steps: [describe, open],
});

const TITLE = 'Add a --shout flag to greet (FAKE-1)';
const BODY = '## Summary\n\nShouts.\n';
const DESCRIBED: ScriptedAnswer = {
  outcome: 'done',
  output: { title: TITLE, bodyFile: 'pr-body.md' },
  files: { 'pr-body.md': BODY },
  messages: ['Described.'],
  usage: { inputTokens: 800, outputTokens: 80, costUsd: 0.25 },
};
/** A describe that leaves out its title: its output breaks the schema. */
const UNTITLED: ScriptedAnswer = { ...DESCRIBED, output: { bodyFile: 'pr-body.md' } };
const OPENS = `cat "$INPUT_TITLE" > /dev/null\necho '{"number":7,"url":"fake://codehost/pull/7"}'`;

interface Setup {
  repo: TempRepo;
  runDir: string;
  harness: Recorded;
  events: NewEvent[];
  /** The request of `publish#1`, or of `definition`, with `ticketKey` bound. */
  request(definition?: Stage, change?: Partial<CallRequest>): CallRequest;
  /** Writes a script of the stage, by its file name, with `body` after the shebang. */
  script(name: string, body: string): void;
  /** A file of the run directory, relative to it, or null when there is none. */
  read(path: string): string | null;
}

/** The stage's folder in `repo`, `describe.md` and an `open.sh` that opens pull request 7, on a fake harness scripted with `answers`. */
function setup(repo: TempRepo, answers: ScriptedAnswer[] = [DESCRIBED]): Setup {
  const stageDir = join(repo.dir, '.sail', 'workflows', 'ticket-to-pr', 'stages', 'publish');
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(join(stageDir, 'describe.md'), 'Describe the change for {{ticketKey}}.\n');
  const runDir = join(repo.dir, '.sail-runs', RUN_ID);
  const harness = recording(createFakeHarness({ script: { 'publish/describe': answers } }));
  const events: NewEvent[] = [];
  const s: Setup = {
    repo,
    runDir,
    harness,
    events,
    request: (definition = publish, change = {}) => ({
      runDir,
      runId: RUN_ID,
      stageIndex: 5,
      call: 1,
      definition,
      stageFile: join(stageDir, 'stage.ts'),
      workspace: repo.dir,
      root: repo.dir,
      branch: 'sail/FAKE-1',
      config: join(repo.dir, '.sail', 'project.yaml'),
      supplied: {
        ticketKey: { kind: 'value', value: 'FAKE-1', from: '01-intake/call-1/result.json#/output/ticketKey' },
      },
      graceMs: 500,
      emit: (event) => events.push(event),
      agent: { harness, model: MODEL, models: { describe: MODEL }, conventions: [] },
      ...change,
    }),
    script: (name, body) => {
      writeFileSync(join(stageDir, name), `#!/bin/bash\nset -euo pipefail\n${body}\n`);
      chmodSync(join(stageDir, name), 0o755);
    },
    read: (path) => (existsSync(join(runDir, path)) ? readFileSync(join(runDir, path), 'utf8') : null),
  };
  s.script('open.sh', OPENS);
  return s;
}

const CALL = '05-publish/call-1';
const json = (s: Setup, path: string): Record<string, unknown> => JSON.parse(s.read(path) ?? '{}');

/** Every result.json under the call, by path, each with the issues sail.result.v1 finds in it. */
function resultIssues(s: Setup): Record<string, string[]> {
  const found = [...new Bun.Glob(`${CALL}/**/result.json`).scanSync({ cwd: s.runDir })].sort();
  return Object.fromEntries(
    found.map((path) => [path, validateDocument('sail.result.v1', json(s, path)).map(formatIssue)]),
  );
}

const stepStarts = (events: readonly NewEvent[]) =>
  events.flatMap((event) => (event.type === 'step:start' ? [`${event.key} ${event.try}`] : []));

test("describe then open: open's $STAGE_IN holds the title and the body describe left in the shared $STAGE_OUT, and the stage's result lists both steps", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    const { result } = await runStageCall(s.request(), publish);
    expect(result).toMatchObject({
      key: 'publish#1',
      outcome: 'passed',
      output: { number: 7, url: 'fake://codehost/pull/7' },
    });

    expect(s.read(`${CALL}/pr-body.md`)).toBe(BODY);
    expect(readdirSync(join(s.runDir, CALL, 'steps', '2-open', 'in')).sort()).toEqual([
      'pr-body.md',
      'ticketKey.txt',
      'title.txt',
    ]);
    expect(s.read(`${CALL}/steps/2-open/in/title.txt`)).toBe(TITLE);
    expect(json(s, `${CALL}/steps/2-open/result.json`)).toMatchObject({
      key: 'publish#1/open',
      step: 'open',
      outcome: 'passed',
      consumed: {
        title: `${CALL}/steps/1-describe/result.json#/output/title`,
        body: `${CALL}/pr-body.md`,
        ticketKey: '01-intake/call-1/result.json#/output/ticketKey',
      },
    });
    const sha256 = new Bun.CryptoHasher('sha256').update(BODY).digest('hex');
    expect(json(s, `${CALL}/result.json`)).toMatchObject({
      key: 'publish#1',
      outcome: 'passed',
      output: { number: 7, url: 'fake://codehost/pull/7' },
      files: { 'pr-body.md': { path: `${CALL}/pr-body.md`, bytes: BODY.length, sha256 } },
      consumed: { ticketKey: '01-intake/call-1/result.json#/output/ticketKey' },
      steps: [
        {
          step: 'describe',
          kind: 'agent',
          outcome: 'done',
          resultPath: `${CALL}/steps/1-describe/result.json`,
          costUsd: 0.25,
        },
        { step: 'open', kind: 'script', outcome: 'passed', resultPath: `${CALL}/steps/2-open/result.json` },
      ],
      usage: { inputTokens: 800, outputTokens: 80, costUsd: 0.25 },
    });
    expect(resultIssues(s)).toEqual({
      [`${CALL}/result.json`]: [],
      [`${CALL}/steps/1-describe/result.json`]: [],
      [`${CALL}/steps/2-open/result.json`]: [],
    });
    // The step links of the stage's result agree with the steps' own results. Nothing else of a run is here.
    const links = validateRunDir(s.runDir).issues.filter((issue) => issue.path.startsWith('/steps/'));
    expect(links.map(formatIssue)).toEqual([]);
  });
});

test("the call's events: its stage:start with its steps, each step's start and end under the step's key, then its stage:end, all valid under sail.event.v1", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    await runStageCall(s.request(), publish);
    const flow = s.events.filter((event) =>
      ['stage:start', 'stage:end', 'step:start', 'step:end'].includes(event.type),
    );
    expect(flow).toEqual([
      {
        type: 'stage:start',
        key: 'publish#1',
        stage: 'publish',
        call: 1,
        try: 1,
        kind: 'stage',
        steps: ['describe', 'open'],
        consumed: { ticketKey: '01-intake/call-1/result.json#/output/ticketKey' },
      },
      {
        type: 'step:start',
        key: 'publish#1/describe',
        stage: 'publish',
        step: 'describe',
        index: 1,
        of: 2,
        kind: 'agent',
        try: 1,
        model: MODEL,
      },
      {
        type: 'step:end',
        key: 'publish#1/describe',
        step: 'describe',
        try: 1,
        outcome: 'done',
        resultPath: `${CALL}/steps/1-describe/result.json`,
      },
      {
        type: 'step:start',
        key: 'publish#1/open',
        stage: 'publish',
        step: 'open',
        index: 2,
        of: 2,
        kind: 'script',
        try: 1,
        command: '.sail/workflows/ticket-to-pr/stages/publish/open.sh',
      },
      {
        type: 'step:end',
        key: 'publish#1/open',
        step: 'open',
        try: 1,
        outcome: 'passed',
        resultPath: `${CALL}/steps/2-open/result.json`,
      },
      expect.objectContaining({
        type: 'stage:end',
        key: 'publish#1',
        try: 1,
        outcome: 'passed',
        resultPath: `${CALL}/result.json`,
      }),
    ]);
    // Everything a step does is under its key, and the harness was asked under it too.
    const keyed = s.events.filter((event) =>
      ['harness:session_start', 'script:exec', 'file:produced'].includes(event.type),
    );
    expect(keyed.map((event) => ('key' in event ? event.key : ''))).toEqual([
      'publish#1/describe',
      'publish#1/describe',
      'publish#1/open',
    ]);
    expect(s.harness.requests.map((request) => request.key)).toEqual(['publish#1/describe']);
    const stamped = s.events.map((event, i) => ({ seq: i + 1, ts: TS, runId: RUN_ID, ...event }));
    expect(stamped.flatMap((event) => validateDocument('sail.event.v1', event)).map(formatIssue)).toEqual([]);
  });
});

const lint = script('lint', { run: './lint.sh', produces: { 'lint.txt': 'file' }, output: LintReport });
const linted = stage('linted', {
  consumes: { ticketKey: value(TicketKey) },
  output: PrInfo,
  steps: [lint, script('open', { run: './open.sh', consumes: { ticketKey: value(TicketKey) }, output: PrInfo })],
});

test.each<[string, Stage, ScriptedAnswer[], string, Record<string, unknown>]>([
  [
    'describe blocked',
    publish,
    [{ outcome: 'blocked', reason: 'the ticket names no change' }],
    'describe',
    { outcome: 'blocked', reason: 'the ticket names no change', output: null },
  ],
  [
    'describe in error',
    publish,
    [{ outcome: 'error', message: 'the model is unavailable' }],
    'describe',
    { outcome: 'error', errors: [{ reason: 'harness', message: 'the model is unavailable' }], output: null },
  ],
  [
    'a first script step failed',
    linted,
    [DESCRIBED],
    'lint',
    { outcome: 'failed', output: { problems: ['no tests'] } },
  ],
  [
    'open in error',
    publish,
    [DESCRIBED],
    'open',
    {
      outcome: 'error',
      errors: [{ reason: 'exit_code', message: 'exit code 3 is not mapped to passed or failed' }],
      output: null,
    },
  ],
])(
  '%s ends the stage with that outcome, and no step after it starts',
  async (_, definition, answers, last, expected) => {
    await withTempRepo(async (repo) => {
      const s = setup(repo, answers);
      s.script('lint.sh', `echo 'no tests' > "$STAGE_OUT/lint.txt"\necho '{"problems":["no tests"]}'\nexit 1`);
      s.script('open.sh', 'exit 3');
      const { result } = await runStageCall(s.request(definition), definition);
      expect(result).toMatchObject(expected);
      const names = definition.steps.map((step) => step.name);
      const ran = names.slice(0, names.indexOf(last) + 1);
      expect(stepStarts(s.events)).toEqual(ran.map((step) => `${definition.name}#1/${step} 1`));
      expect((result.steps as { step: string }[]).map((step) => step.step)).toEqual(ran);
      expect(json(s, `05-${definition.name}/call-1/result.json`)).toMatchObject({
        ...expected,
        key: `${definition.name}#1`,
      });
      expect(existsSync(join(s.runDir, `05-${definition.name}`, 'call-1', 'steps', `${ran.length + 1}-open`))).toBe(
        false,
      );
    });
  },
);

test("describe's invalid output is corrected once inside its step: try-2 runs in its own step directory, told the problem, and open then runs once", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo, [UNTITLED, DESCRIBED]);
    const { result } = await runStageCall(s.request(), publish);
    expect(result).toMatchObject({ outcome: 'passed' });
    expect(stepStarts(s.events)).toEqual(['publish#1/describe 1', 'publish#1/describe 2', 'publish#1/open 1']);
    expect(json(s, `${CALL}/steps/1-describe/try-2/result.json`)).toMatchObject({
      key: 'publish#1/describe',
      try: 2,
      validationTry: 2,
      outcome: 'done',
    });
    expect(s.read(`${CALL}/steps/1-describe/try-2/prompt.md`)).toContain('→ at title');
    expect(json(s, `${CALL}/result.json`)).toMatchObject({
      steps: [{ step: 'describe', resultPath: `${CALL}/steps/1-describe/try-2/result.json` }, { step: 'open' }],
    });
    expect(s.read(`${CALL}/steps/2-open/in/title.txt`)).toBe(TITLE);
  });
});

test('describe invalid in both tries ends the stage in error, and open never starts', async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo, [UNTITLED, UNTITLED]);
    const { result } = await runStageCall(s.request(), publish);
    expect(result).toMatchObject({ outcome: 'error', steps: [{ step: 'describe', outcome: 'error' }] });
    expect(stepStarts(s.events)).toEqual(['publish#1/describe 1', 'publish#1/describe 2']);
    expect(existsSync(join(s.runDir, CALL, 'steps', '2-open'))).toBe(false);
  });
});

test("a step already journaled is not run again: open takes describe's title from its journal line, not from the result.json a session may rewrite", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    // A first process: describe runs and is journaled, then the call stops before open.
    let heard: Record<string, unknown> | undefined;
    const first = await runStageCall(s.request(), publish, {
      onStep: (result) => {
        heard = result;
        return false;
      },
    });
    expect([first.stopped, heard?.key]).toEqual([true, 'publish#1/describe']);
    const entry: JournalEntry = {
      seq: 3,
      key: 'publish#1/describe',
      stage: 'publish',
      call: 1,
      step: 'describe',
      outcome: 'done',
      output: heard?.output,
      reason: null,
      files: { 'pr-body.md': `${CALL}/pr-body.md` },
      resultPath: `${CALL}/steps/1-describe/result.json`,
      recordedAt: TS,
    };
    const path = join(s.runDir, entry.resultPath);
    const rewritten = {
      ...JSON.parse(readFileSync(path, 'utf8')),
      output: { title: 'Planted', bodyFile: 'pr-body.md' },
    };
    writeFileSync(path, JSON.stringify(rewritten));

    const asked = s.harness.requests.length;
    const hooks: StageHooks = { finished: [entry] };
    const { result } = await runStageCall(s.request(), publish, hooks);
    expect(result).toMatchObject({ outcome: 'passed', steps: [{ step: 'describe' }, { step: 'open' }] });
    expect(s.harness.requests.length).toBe(asked);
    expect(stepStarts(s.events)).toEqual(['publish#1/describe 1', 'publish#1/open 1']);
    expect(s.read(`${CALL}/steps/2-open/in/title.txt`)).toBe(TITLE);
  });
});

const commit = script('commit', { run: './commit.sh', output: z.object({ sha: z.string() }) });
const review = script('review', {
  run: './review.sh',
  consumes: { diff: gitDiff('HEAD~1..HEAD') },
  output: z.object({ files: z.number().int() }),
});
const reviewed = stage('reviewed', { output: review.output, steps: [commit, review] });

test("a step's gitDiff is taken just before it starts, after the step before it committed, and one that fails ends that step in error, not_started", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    s.script(
      'commit.sh',
      `echo shout > shout.txt\ngit add shout.txt\ngit commit -qm shout\necho "{\\"sha\\":\\"$(git rev-parse HEAD)\\"}"`,
    );
    s.script('review.sh', `echo "{\\"files\\":$(grep -c '^diff --git' "$INPUT_DIFF")}"`);
    const diff = async (range: string) =>
      Bun.spawnSync(['git', 'diff', range], { cwd: repo.dir, env: repo.env }).stdout.toString();
    const { result } = await runStageCall(s.request(reviewed, { supplied: {} }), reviewed, { diff });
    expect(result).toMatchObject({ outcome: 'passed', output: { files: 1 } });
    expect(s.read('05-reviewed/call-1/steps/2-review/in/diff.patch')).toContain('+++ b/shout.txt');

    await withTempRepo(async (other) => {
      const t = setup(other);
      t.script('commit.sh', `echo '{"sha":"none"}'`);
      t.script('review.sh', `echo '{"files":0}'`);
      const failing = async () => {
        throw new Error('fatal: bad revision');
      };
      const stopped = await runStageCall(t.request(reviewed, { supplied: {} }), reviewed, { diff: failing });
      expect(stopped.result).toMatchObject({
        outcome: 'error',
        errors: [{ reason: 'not_started', message: "'diff': gitDiff(HEAD~1..HEAD) failed: fatal: bad revision" }],
        steps: [
          { step: 'commit', outcome: 'passed' },
          { step: 'review', outcome: 'error' },
        ],
      });
      expect(existsSync(join(t.runDir, '05-reviewed', 'call-1', 'steps', '2-review', 'in', 'diff.patch'))).toBe(false);
    });
  });
});

test('an abort between steps starts no further step and writes no stage result: only the step before it was heard', async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    const controller = new AbortController();
    const heard: unknown[] = [];
    const ran = await runStageCall(s.request(publish, { signal: controller.signal }), publish, {
      onStep: (result) => {
        heard.push(result.key);
        controller.abort();
        return false;
      },
    });
    expect([ran.stopped, heard]).toEqual([true, ['publish#1/describe']]);
    expect(stepStarts(s.events)).toEqual(['publish#1/describe 1']);
    expect([s.read(`${CALL}/result.json`), s.events.some((event) => event.type === 'stage:end')]).toEqual([
      null,
      false,
    ]);
  });
});

test("a stage of one step runs as that step, under the stage's name: call-1/result.json is the step's, and there is no steps/", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    const alone = stage('alone', {
      consumes: { ticketKey: value(TicketKey) },
      output: PrInfo,
      steps: [script('open', { run: './open.sh', consumes: { ticketKey: value(TicketKey) }, output: PrInfo })],
    });
    s.script('open.sh', `echo '{"number":8,"url":"fake://codehost/pull/8"}'`);
    const ran = await runCall(s.request(alone)).catch((error: Error) => ({ refused: error.message }));
    expect(ran).toMatchObject({ result: { key: 'alone#1', kind: 'script', outcome: 'passed', output: { number: 8 } } });
    expect(readdirSync(join(s.runDir, '05-alone', 'call-1')).sort()).toEqual([
      'in',
      'result.json',
      'stderr.log',
      'stdout.log',
    ]);
    expect(json(s, '05-alone/call-1/result.json')).not.toHaveProperty('steps');
  });
});

test("callProblems of a multi-step stage lists each step's own problems by step, then the stage's bindings', and an agent step with nothing to run on", () => {
  const broken = stage('broken', {
    consumes: { ticketKey: value(TicketKey) },
    output: PrInfo,
    steps: [
      agent('describe', { ...describe, budget: { ...budget, maxTurns: 0 } }),
      script('open', { run: './open.sh', output: PrInfo, timeoutSeconds: -1 }),
    ],
  });
  const harness = createFakeHarness({ script: {} });
  const unbound: Record<string, Supplied> = {};
  expect(callProblems(broken, unbound, { harness, model: MODEL })).toEqual([
    "step 'describe': budget.maxTurns must be a whole number of 1 or more: 0",
    "step 'open': timeoutSeconds must be a positive number: -1",
    "'ticketKey' is required",
  ]);
  expect(callProblems(publish, { ticketKey: { kind: 'value', value: 'FAKE-1', from: 'x' } })).toEqual([
    "agent steps need a harness and a model, which weren't resolved",
  ]);
  expect(
    callProblems(publish, { ticketKey: { kind: 'value', value: 'FAKE-1', from: 'x' } }, { harness, model: MODEL }),
  ).toEqual([]);
});
