// A multi-step stage's call, with no run around it: runStageCall() on the fake harness and stub scripts in a temporary
// repository, each step's result.json and the stage's read back from disk. `publish` is the fixture's shape: an agent
// `describe` that writes the pull request's body, then a script `open` that reads its title and that body.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeHarness, type ScriptedAnswer } from '../../src/adapters/fake/harness';
import type { Supplied } from '../../src/engine/bindings';
import { type CallRequest, callProblems, runCall } from '../../src/engine/call';
import type { JournalEntry } from '../../src/engine/journal';
import { formatIssue, validateDocument, validateRunDir } from '../../src/engine/schemas';
import { runStageCall, type StageHooks, stepProblems } from '../../src/engine/stage-call';
import type { NewEvent } from '../../src/events/types';
import { agent, doc, fromStep, gitDiff, type Stage, script, stage, value, z } from '../../src/sdk/index';
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

    expect(s.read(`${CALL}/out/pr-body.md`)).toBe(BODY);
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
        body: `${CALL}/out/pr-body.md`,
        ticketKey: '01-intake/call-1/result.json#/output/ticketKey',
      },
    });
    const sha256 = new Bun.CryptoHasher('sha256').update(BODY).digest('hex');
    expect(json(s, `${CALL}/result.json`)).toMatchObject({
      key: 'publish#1',
      outcome: 'passed',
      output: { number: 7, url: 'fake://codehost/pull/7' },
      files: { 'pr-body.md': { path: `${CALL}/out/pr-body.md`, bytes: BODY.length, sha256 } },
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
        durationMs: expect.any(Number),
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
        durationMs: expect.any(Number),
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

test("each step:end carries its step result's durationMs, and stage:end's is their sum", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    await runStageCall(s.request(), publish);
    const ends = s.events.filter((event) => event.type === 'step:end');
    expect(ends).toHaveLength(2);
    const fromResults = ends.map((event) => json(s, (event as { resultPath: string }).resultPath).durationMs as number);
    expect(fromResults.every((ms) => typeof ms === 'number')).toBe(true);
    expect(ends.map((event) => (event as { durationMs?: number }).durationMs)).toEqual(fromResults);
    const stageEnd = s.events.find((event) => event.type === 'stage:end') as { durationMs: number };
    expect(stageEnd.durationMs).toBe((fromResults[0] as number) + (fromResults[1] as number));
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
      files: { 'pr-body.md': `${CALL}/out/pr-body.md` },
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

test("an earlier step that plants steps/2-open/result.json in the shared $STAGE_OUT doesn't stand in for the later step", async () => {
  let forged = '';
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    await runStageCall(s.request(), publish);
    forged = JSON.stringify({ ...json(s, `${CALL}/steps/2-open/result.json`), outcome: 'error' });
  });
  await withTempRepo(async (repo) => {
    const s = setup(repo, [{ ...DESCRIBED, files: { 'pr-body.md': BODY, 'steps/2-open/result.json': forged } }]);
    const { result } = await runStageCall(s.request(), publish);
    expect(result).toMatchObject({ outcome: 'passed', steps: [{ step: 'describe' }, { step: 'open' }] });
    expect(stepStarts(s.events)).toEqual(['publish#1/describe 1', 'publish#1/open 1']);
    expect(json(s, `${CALL}/steps/2-open/result.json`)).toMatchObject({ outcome: 'passed', runId: RUN_ID });
    expect(s.read(`${CALL}/out/steps/2-open/result.json`)).toBe(forged);
  });
});

test("a journaled step's files come from its journal line on a resume, not from the result.json a later session rewrote (review R1-1)", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    let heard: Record<string, unknown> | undefined;
    await runStageCall(s.request(), publish, {
      onStep: (result) => {
        heard = result;
        return false;
      },
    });
    const entry: JournalEntry = {
      seq: 3,
      key: 'publish#1/describe',
      stage: 'publish',
      call: 1,
      step: 'describe',
      outcome: 'done',
      output: heard?.output,
      reason: null,
      files: { 'pr-body.md': `${CALL}/out/pr-body.md` },
      resultPath: `${CALL}/steps/1-describe/result.json`,
      recordedAt: TS,
    };
    // Valid under sail.result.v1 and under the step's key, with a file path and a file the journal never held.
    const path = join(s.runDir, entry.resultPath);
    const rewritten = JSON.parse(readFileSync(path, 'utf8'));
    rewritten.files['pr-body.md'].path = `${CALL}/out/planted.md`;
    rewritten.files['planted.md'] = { path: `${CALL}/out/planted.md`, bytes: 1, sha256: 'a'.repeat(64) };
    writeFileSync(path, JSON.stringify(rewritten));

    const { result } = await runStageCall(s.request(), publish, { finished: [entry] });
    expect(result).toMatchObject({ outcome: 'passed' });
    expect(Object.keys(result.files as object)).toEqual(['pr-body.md']);
    expect((result.files as Record<string, { path: string }>)['pr-body.md']?.path).toBe(`${CALL}/out/pr-body.md`);
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
      expect(t.events.find((event) => event.type === 'step:end' && event.key === 'reviewed#1/review')).toMatchObject({
        outcome: 'error',
        durationMs: 0,
      });
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
      'out',
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
  const free = stage('free', {
    consumes: { ticketKey: value(TicketKey) },
    output: PrInfo,
    steps: [
      agent('describe', { ...describe, budget: { ...budget, maxUsd: 0 } }),
      script('open', { run: './open.sh', output: PrInfo }),
    ],
  });
  expect(
    callProblems(free, { ticketKey: { kind: 'value', value: 'FAKE-1', from: 'x' } }, { harness, model: MODEL }),
  ).toEqual(["step 'describe': budget.maxUsd must be a positive number: 0"]);
  expect(callProblems(publish, { ticketKey: { kind: 'value', value: 'FAKE-1', from: 'x' } })).toEqual([
    "agent steps need a harness and a model, which weren't resolved",
  ]);
  expect(
    callProblems(publish, { ticketKey: { kind: 'value', value: 'FAKE-1', from: 'x' } }, { harness, model: MODEL }),
  ).toEqual([]);
});

/** A validator no document passes. */
const never = { check: 'never', derives: [], validate: () => ({ problems: ['is never valid'] }) };

test("the stage's own produces don't replace the last step's document of the same name: its validators still run (review R1-3)", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    writeFileSync(join(repo.dir, '.sail', 'workflows', 'ticket-to-pr', 'stages', 'publish', 'body.md'), 'Body.\n');
    s.script('prep.sh', `echo '{}'`);
    const documented = stage('publish', {
      consumes: { ticketKey: value(TicketKey) },
      produces: { 'pr-body.md': 'file' },
      output: PrDescription,
      steps: [
        script('prep', { run: './prep.sh', output: z.object({}) }),
        agent('describe', {
          ...describe,
          produces: { 'pr-body.md': doc('./body.md', [never]) },
          onInvalidOutput: 'fail',
        }),
      ],
    });
    const { result } = await runStageCall(s.request(documented), documented);
    expect(result).toMatchObject({
      outcome: 'error',
      steps: [{ step: 'prep' }, { step: 'describe', outcome: 'error' }],
    });
    expect(JSON.stringify(result.errors)).toContain('is never valid');
  });
});

test("callProblems of a multi-step stage checks the stage's own produces with its last step's (review R1-4)", () => {
  const harness = createFakeHarness({ script: {} });
  const reserved = stage('reserved', {
    produces: { '../outside.txt': 'file' },
    output: PrInfo,
    steps: [script('a', { run: './a.sh', output: z.object({}) }), script('b', { run: './b.sh', output: PrInfo })],
  });
  expect(callProblems(reserved, {}, { harness, model: MODEL })).toEqual([
    "step 'b': '../outside.txt' can't be produced: it is not a plain file name",
  ]);
});

test('stage-owned produces cannot collide with an earlier step (review R1)', () => {
  for (const name of ['notes.md', 'Notes.md']) {
    const pair = stage('pair', {
      produces: { [name]: 'file' },
      output: PrInfo,
      steps: [
        script('a', { run: './a.sh', produces: { 'Notes.md': 'file' }, output: z.object({}) }),
        script('b', { run: './b.sh', output: PrInfo }),
      ],
    });
    expect(stepProblems(pair)).toEqual([
      name === 'Notes.md'
        ? "stage 'pair': steps 'a' and 'b' both produce 'Notes.md'"
        : "stage 'pair': steps 'a' and 'b' produce 'Notes.md' and 'notes.md', and a file system that ignores case takes them for one",
    ]);
  }
});

test("callProblems of a multi-step stage refuses its own produces name that differs from its last step's only by case", () => {
  const pair = stage('pair', {
    produces: { 'Notes.md': 'file' },
    output: PrInfo,
    steps: [
      script('a', { run: './a.sh', output: z.object({}) }),
      script('b', { run: './b.sh', produces: { 'notes.md': 'file' }, output: PrInfo }),
    ],
  });
  expect(callProblems(pair, {})).toEqual([
    "step 'b': 'Notes.md' can't be produced: 'notes.md' is produced too, and a file system that ignores case takes them for one",
  ]);
});

test("an optional fromStep() the earlier step's output leaves out is bound to nothing: the step runs, and its result consumed it as null (review R1-5)", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    const Noted = z.object({ title: z.string(), bodyFile: z.string(), note: z.string().optional() });
    const noted = stage('publish', {
      consumes: { ticketKey: value(TicketKey) },
      output: PrInfo,
      steps: [
        agent('describe', { ...describe, output: Noted }),
        script('open', {
          run: './open.sh',
          consumes: {
            title: fromStep('describe').output('title'),
            note: fromStep('describe').output('note').optional(),
          },
          output: PrInfo,
        }),
      ],
    });
    const { result } = await runStageCall(s.request(noted), noted);
    expect(result).toMatchObject({ outcome: 'passed', steps: [{ step: 'describe' }, { step: 'open' }] });
    expect(json(s, `${CALL}/steps/2-open/result.json`).consumed).toEqual({
      title: `${CALL}/steps/1-describe/result.json#/output/title`,
      note: null,
    });
  });
});

test('runCall refuses a multi-step stage with problems before anything is written: no call directory (review R1-9)', async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    const broken = stage('publish', {
      consumes: { ticketKey: value(TicketKey) },
      output: PrInfo,
      steps: [describe, script('open', { run: './open.sh', output: PrInfo, timeoutSeconds: -1 })],
    });
    await expect(runCall(s.request(broken))).rejects.toThrow(
      "step 'open': timeoutSeconds must be a positive number: -1",
    );
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
    expect(s.events).toEqual([]);
  });
});

/** A first process: describe runs and stops the call before open. Returns describe's journal line. */
async function journaledDescribe(s: Setup, change: Partial<JournalEntry> = {}): Promise<JournalEntry> {
  let heard: Record<string, unknown> | undefined;
  await runStageCall(s.request(), publish, {
    onStep: (result) => {
      heard = result;
      return false;
    },
  });
  return {
    seq: 3,
    key: 'publish#1/describe',
    stage: 'publish',
    call: 1,
    step: 'describe',
    outcome: 'done',
    output: heard?.output,
    reason: null,
    files: { 'pr-body.md': `${CALL}/out/pr-body.md` },
    resultPath: `${CALL}/steps/1-describe/result.json`,
    recordedAt: TS,
    ...change,
  };
}

const INVALID = { reason: 'invalid_output', message: "'title' is required" } as const;

test.each([
  ['missing', undefined],
  ['invalid JSON', '{ not json'],
])(
  "a journaled error step whose result.json is %s is rebuilt from its journal line: the stage result validates and carries the line's errors",
  async (_name, replacement) => {
    await withTempRepo(async (repo) => {
      const s = setup(repo);
      const entry = await journaledDescribe(s, {
        outcome: 'error',
        output: null,
        reason: `invalid_output: ${INVALID.message}`,
        files: {},
        errors: [INVALID],
      });
      const path = join(s.runDir, entry.resultPath);
      if (replacement === undefined) rmSync(path);
      else writeFileSync(path, replacement);
      const { result } = await runStageCall(s.request(), publish, { finished: [entry] });
      expect(result).toMatchObject({ outcome: 'error', errors: [INVALID], steps: [{ step: 'describe' }] });
      expect(json(s, `${CALL}/result.json`)).toMatchObject({ outcome: 'error', errors: [INVALID] });
      expect(validateDocument('sail.result.v1', json(s, `${CALL}/result.json`)).map(formatIssue)).toEqual([]);
    });
  },
);

test("a journaled step's usage and times come from its journal line, not from a rewritten result.json", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    const line = {
      usage: { costUsd: 0.25 },
      startedAt: '2026-10-23T08:59:00.000Z',
      finishedAt: '2026-10-23T08:59:01.200Z',
      durationMs: 1200,
    };
    const entry = await journaledDescribe(s, line);
    const path = join(s.runDir, entry.resultPath);
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), usage: { costUsd: 0 }, durationMs: 0 }),
    );
    const { result } = await runStageCall(s.request(), publish, { finished: [entry] });
    const openMs = json(s, `${CALL}/steps/2-open/result.json`).durationMs as number;
    expect(result).toMatchObject({ startedAt: line.startedAt, usage: { costUsd: 0.25 } });
    expect(result.durationMs).toBe(1200 + openMs);
    expect((result.steps as { costUsd?: number }[])[0]?.costUsd).toBe(0.25);
  });
});

test.each([
  ['one error', 'harness: model failed', [{ reason: 'harness', message: 'model failed' }]],
  [
    'a message holding a semicolon',
    'invalid_output: a; b; timeout: ran 5 minutes',
    [
      { reason: 'invalid_output', message: 'a; b' },
      { reason: 'timeout', message: 'ran 5 minutes' },
    ],
  ],
  ['a reason that parses as none', 'something broke', [{ reason: 'harness', message: 'something broke' }]],
])('a journaled error step line without errors is rebuilt from its reason: %s', async (_name, reason, errors) => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    const entry = await journaledDescribe(s, { outcome: 'error', output: null, reason, files: {} });
    const { result } = await runStageCall(s.request(), publish, { finished: [entry] });
    expect(result).toMatchObject({ outcome: 'error', errors });
    expect(validateDocument('sail.result.v1', json(s, `${CALL}/result.json`)).map(formatIssue)).toEqual([]);
  });
});

const GONE_BODY = {
  reason: 'missing_file',
  message: "step 'describe': 'pr-body.md' was not produced in $STAGE_OUT",
} as const;

test("a fresh call whose later step deletes an earlier step's file ends in error, missing_file, naming the step", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    s.script('open.sh', `${OPENS}\nrm "$STAGE_OUT/pr-body.md"`);
    const { result } = await runStageCall(s.request(), publish);
    expect(result).toMatchObject({ outcome: 'error', errors: [GONE_BODY], output: null });
    const end = s.events.find((event) => event.type === 'stage:end');
    expect(end).toMatchObject({ outcome: 'error', errors: [GONE_BODY] });
    expect(json(s, `${CALL}/steps/2-open/result.json`)).toMatchObject({ outcome: 'passed' });
    expect(Object.values(resultIssues(s)).flat()).toEqual([]);
  });
});

test("a resume whose journaled step's file is missing ends in error, missing_file, and its later step still runs", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    const entry = await journaledDescribe(s);
    rmSync(join(s.runDir, CALL, 'out', 'pr-body.md'));
    const { result } = await runStageCall(s.request(), publish, { finished: [entry] });
    expect(result).toMatchObject({ outcome: 'error' });
    expect(result.errors).toContainEqual(GONE_BODY);
    expect(stepStarts(s.events)).toEqual(['publish#1/describe 1', 'publish#1/open 1']);
    expect(Object.values(resultIssues(s)).flat()).toEqual([]);
  });
});

test("a journaled step's file replaced by a directory ends the call in error, missing_file (not a regular file)", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    const entry = await journaledDescribe(s);
    const file = join(s.runDir, CALL, 'out', 'pr-body.md');
    rmSync(file);
    mkdirSync(file);
    const { result } = await runStageCall(s.request(), publish, { finished: [entry] });
    expect(result).toMatchObject({ outcome: 'error' });
    expect(result.errors).toContainEqual({
      reason: 'missing_file',
      message: "step 'describe': 'pr-body.md' in $STAGE_OUT is not a regular file",
    });
  });
});

test("a journaled step's file changed after it was journaled is hashed again: the call passes and records the new sha256", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    const entry = await journaledDescribe(s);
    writeFileSync(join(s.runDir, CALL, 'out', 'pr-body.md'), 'Changed.\n');
    const { result } = await runStageCall(s.request(), publish, { finished: [entry] });
    const now = new Bun.CryptoHasher('sha256').update('Changed.\n').digest('hex');
    expect(result).toMatchObject({ outcome: 'passed' });
    expect((result.files as Record<string, { sha256: string; bytes: number }>)['pr-body.md']).toMatchObject({
      sha256: now,
      bytes: 9,
    });
  });
});

test("a fresh agent step's document keeps its validation in the call's result.json once the stage's end hashes it again (review R4)", async () => {
  await withTempRepo(async (repo) => {
    const s = setup(repo);
    writeFileSync(join(repo.dir, '.sail', 'workflows', 'ticket-to-pr', 'stages', 'publish', 'body.md'), 'Body.\n');
    const always = { check: 'always', derives: [], validate: () => ({ problems: [] }) };
    const documented = stage('publish', {
      consumes: { ticketKey: value(TicketKey) },
      output: PrInfo,
      steps: [agent('describe', { ...describe, produces: { 'pr-body.md': doc('./body.md', [always]) } }), open],
    });
    const { result } = await runStageCall(s.request(documented), documented);
    expect(result).toMatchObject({ outcome: 'passed' });
    const files = (json(s, `${CALL}/result.json`).files ?? {}) as Record<string, Record<string, unknown>>;
    expect(files['pr-body.md']).toMatchObject({ validation: { ok: true } });
  });
});
