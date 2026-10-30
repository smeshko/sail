// writeTwoStepRun(): a run directory written by hand, holding what no run writes yet: one call of a two-step stage,
// `publish`, with its step results, its journal lines, its events and the summary they fold to. The engine can't run a
// multi-step stage until it gains the step loop, and the fake harness reports no tool call, so nothing here is run: the
// files are the shape a run will write, cut down to one call. Its first step's two sessions made five tool calls, one
// of them denied.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { summarize } from '../../src/events/summary';
import type { NewEvent, SailEvent } from '../../src/events/types';
import {
  at,
  denied,
  journal,
  ndjson,
  RUN_ID,
  route,
  runEnd,
  runStart,
  session,
  stamp,
  start,
  stepEnd,
  stepStart,
  thinking,
  toolEnd,
  toolStart,
  validated,
} from './events';

export const TWO_STEP_RUN_ID = RUN_ID;

const CALL = '05-publish/call-1';
const DESCRIBE_DIR = `${CALL}/steps/1-describe`;
const OPEN_DIR = `${CALL}/steps/2-open`;
const DESCRIBE = 'publish#1/describe';
const OPEN = 'publish#1/open';
const COMMANDS = ['git log *', 'git diff *'];
const PR_BODY = '## Summary\n\nAdds `--shout` to the `greet` command.\n';
const PR = { number: 1, url: 'fake://codehost/fixture/pull/1', draft: false };
const DESCRIBED = { title: 'Add a --shout flag to the greet command (FAKE-1)', bodyFile: 'pr-body.md' };
const CONSUMED = { ticket: '00-intake/call-1/result.json#/output', spec: '01-spec/call-1/out/spec.md' };
const fake = { use: 'fake', origin: 'builtin' };

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
const body = { path: `${DESCRIBE_DIR}/pr-body.md`, bytes: Buffer.byteLength(PR_BODY), sha256: sha256(PR_BODY) };

/** The run's events: the two-step call from its start to the run's end, with both of its first step's sessions. */
export function twoStepEvents(): SailEvent[] {
  const produced: NewEvent = { type: 'file:produced', key: DESCRIBE, name: 'pr-body.md', ...body };
  return stamp(
    [0, runStart({ maxUsd: 25, maxMinutes: 90 })],
    [100, start('publish#1', { kind: 'stage', steps: ['describe', 'open'], consumed: CONSUMED })],
    [200, stepStart(DESCRIBE, 1, 2, 'agent')],
    // A first session whose output was sent back, then the one that submitted.
    [300, toolStart(DESCRIBE, 'tool-1', 'Read', { path: '01-spec/call-1/out/spec.md' })],
    [340, toolEnd(DESCRIBE, 'tool-1', 'completed', 40)],
    [400, toolStart(DESCRIBE, 'tool-2', 'Bash', { command: 'git log --oneline main..' })],
    [470, toolEnd(DESCRIBE, 'tool-2', 'completed', 70)],
    [500, session(DESCRIBE, { turns: 2, toolCalls: 2, denials: 0, usage: { costUsd: 0.05 } })],
    [600, thinking(DESCRIBE, 'Summarise the change for a reviewer: what, why, and how it was tested.')],
    [700, toolStart(DESCRIBE, 'tool-3', 'Read', { path: '01-spec/call-1/out/spec.md' })],
    [725, toolEnd(DESCRIBE, 'tool-3', 'completed', 25)],
    [800, toolStart(DESCRIBE, 'tool-4', 'Bash', { command: 'git push origin HEAD' })],
    [800, denied(DESCRIBE, 'tool-4', COMMANDS, "'git push origin HEAD' matches none of the step's commands")],
    [800, toolEnd(DESCRIBE, 'tool-4', 'denied', 0)],
    [900, toolStart(DESCRIBE, 'tool-5', 'Bash', { command: 'git log --oneline main..' })],
    [912, toolEnd(DESCRIBE, 'tool-5', 'failed', 12)],
    [1000, session(DESCRIBE, { turns: 4, toolCalls: 3, denials: 1, usage: { costUsd: 0.101 } })],
    [1010, { type: 'output:validated', key: DESCRIBE }],
    [1020, validated(DESCRIBE, 'pr-body.md', ['hasSections(Summary, Changes, Testing)', 'noPlaceholders'])],
    [1030, produced],
    [1200, { ...stepEnd(DESCRIBE, 1, 'done'), resultPath: `${DESCRIBE_DIR}/result.json` } as NewEvent],
    [1210, journal(DESCRIBE, 1, 'done')],
    [1300, stepStart(OPEN, 2, 2, 'script')],
    [3200, { type: 'script:exit', key: OPEN, code: 0, outcome: 'passed', durationMs: 1900, stdoutBytes: 66 }],
    [3210, { type: 'output:validated', key: OPEN }],
    [3300, { ...stepEnd(OPEN, 2, 'passed'), resultPath: `${OPEN_DIR}/result.json` } as NewEvent],
    [3310, journal(OPEN, 2, 'passed')],
    [
      3400,
      {
        type: 'stage:end',
        key: 'publish#1',
        stage: 'publish',
        call: 1,
        try: 1,
        outcome: 'passed',
        durationMs: 3300,
        resultPath: `${CALL}/result.json`,
      },
    ],
    [3410, journal('publish#1', 3, 'passed')],
    [3420, route('publish#1', 'passed', 'end')],
    [3500, runEnd('completed', 2, { result: { pr: PR } })],
  );
}

const header = {
  schema: 'sail.run.v1',
  runId: RUN_ID,
  source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] },
  claim: { claimed: true, state: { type: 'started', name: 'In Progress' } },
  workflow: { name: 'ticket-to-pr', version: 1, origin: 'repo:.sail/workflows/ticket-to-pr', sha256: '0'.repeat(64) },
  sail: { version: '0.0.0', runtime: 'bun 1.3.14' },
  adapters: { ticketSource: fake, codeHost: fake, harness: fake, workspace: fake },
  intake: { name: 'ticket', origin: 'builtin', output: 'TicketInput', produces: ['ticket.json', 'brief.md'] },
  stages: {
    publish: {
      origin: 'repo:.sail/workflows/ticket-to-pr/stages/publish',
      output: 'PrInfo',
      steps: [
        {
          step: 'describe',
          kind: 'agent',
          model: 'claude-sonnet-5',
          output: 'PrDescription',
          produces: ['pr-body.md'],
          permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: COMMANDS },
          budget: { maxTurns: 20, maxUsd: 1, maxMinutes: 5 },
        },
        { step: 'open', kind: 'script', output: 'PrInfo' },
      ],
    },
  },
  budget: { maxUsd: 25, maxMinutes: 90 },
  startedAt: at(0),
};

const result = (fields: Record<string, unknown>, from: number, to: number) => ({
  schema: 'sail.result.v1',
  runId: RUN_ID,
  stage: 'publish',
  call: 1,
  ...fields,
  startedAt: at(from),
  finishedAt: at(to),
  durationMs: to - from,
});

const describeResult = result(
  {
    step: 'describe',
    key: DESCRIBE,
    kind: 'agent',
    outcome: 'done',
    output: DESCRIBED,
    files: { 'pr-body.md': body },
    consumed: CONSUMED,
    harness: {
      adapter: 'fake',
      model: 'claude-sonnet-5',
      provider: 'fake',
      sessionId: `session-${DESCRIBE}`,
      turns: 4,
      toolCalls: 3,
      denials: 1,
    },
    usage: { costUsd: 0.101 },
  },
  200,
  1200,
);

const openResult = result(
  {
    step: 'open',
    key: OPEN,
    kind: 'script',
    outcome: 'passed',
    output: PR,
    files: {},
    consumed: { description: `${DESCRIBE_DIR}/result.json#/output` },
    exit: { code: 0, mapped: 'passed' },
    command: '.sail/workflows/ticket-to-pr/stages/publish/open.sh',
    env: { RUN_ID, STAGE: 'publish', CALL: '1', TRY: '1' },
  },
  1300,
  3300,
);

const callResult = result(
  {
    key: 'publish#1',
    outcome: 'passed',
    output: PR,
    files: { 'pr-body.md': body },
    consumed: CONSUMED,
    steps: [
      { step: 'describe', kind: 'agent', outcome: 'done', resultPath: `${DESCRIBE_DIR}/result.json`, costUsd: 0.101 },
      { step: 'open', kind: 'script', outcome: 'passed', resultPath: `${OPEN_DIR}/result.json` },
    ],
    usage: { costUsd: 0.101 },
  },
  100,
  3400,
);

/** A journal line of the run: what its result recorded, under its place in the journal. */
const journaled = (seq: number, written: Record<string, unknown>, resultPath: string, ms: number) => {
  const { key, stage, call, step, outcome, output } = written;
  const files = Object.fromEntries(
    Object.entries(written.files as Record<string, { path: string }>).map(([name, file]) => [name, file.path]),
  );
  return {
    seq,
    key,
    stage,
    call,
    ...(step === undefined ? {} : { step }),
    outcome,
    output,
    reason: null,
    files,
    resultPath,
    recordedAt: at(ms),
  };
};

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Writes the run directory into `dir`, which need not exist, and returns the files it wrote, relative to it. */
export function writeTwoStepRun(dir: string): string[] {
  const events = twoStepEvents();
  const journalLines = [
    journaled(1, describeResult, `${DESCRIBE_DIR}/result.json`, 1210),
    journaled(2, openResult, `${OPEN_DIR}/result.json`, 3310),
    journaled(3, callResult, `${CALL}/result.json`, 3410),
  ];
  const files: Record<string, string> = {
    'run.json': json(header),
    STATUS: 'completed\n',
    'journal.ndjson': journalLines.map((line) => `${JSON.stringify(line)}\n`).join(''),
    'events.ndjson': ndjson(events),
    'summary.json': json(summarize(events)),
    [`${CALL}/result.json`]: json(callResult),
    [`${DESCRIBE_DIR}/result.json`]: json(describeResult),
    [`${DESCRIBE_DIR}/pr-body.md`]: PR_BODY,
    [`${OPEN_DIR}/result.json`]: json(openResult),
    [`${OPEN_DIR}/stdout.log`]: `${JSON.stringify(PR)}\n`,
    [`${OPEN_DIR}/stderr.log`]: '',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return Object.keys(files).sort();
}
