// `sail run --from-run <run> --stage <stage> [--continue]`, in process through run(), on copies of the fixture
// repository. The source is `sail FAKE-1` run to its end once in a repository of its own, and each case copies it into
// its own: a process opens one run per `.sail/`. The fake harness answers by call key, not by prompt, so a changed
// answer in `.sail/fake/harness.json` stands in for the different output an edited prompt would get (DECISIONS D10).
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EXIT_OK, EXIT_REFUSED, EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { readJournal } from '../../src/engine/journal';
import { recordingKeepAwake } from '../../src/engine/keep-awake';
import { readStatus } from '../../src/engine/run-dir';
import { readEvents } from '../../src/events/consumers/ndjson';
import { edit } from '../helpers/fixture';
import { type CaptureOptions, fakeInterrupts, runCaptured } from '../helpers/run-captured';
import { cutJournal, runIds, sharedSource } from '../helpers/seeded';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const source = sharedSource();
afterAll(() => source.release());

const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';
const PROMPT = 'workflows/ticket-to-pr/stages/spec/prompt.md';
const EDIT = 'Keep the spec to one page.';
const SUMMARY = 'Add --shout to greet() and the CLI, upper-casing the whole line.';
const USAGE = 'sail run: usage: sail run --from-run <run> --stage <stage> [--continue] [--run-id <id>]\n';
const STAGES = 'implement, publish, self-review, spec, tests';

const sha256 = (path: string) => new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');
const json = (...path: string[]) => JSON.parse(readFileSync(join(...path), 'utf8'));

/** Changes the first scripted answer of `spec` in the repository's fake harness script. */
function answerSpec(repoDir: string, change: (answer: Record<string, unknown>) => Record<string, unknown>): void {
  const path = join(repoDir, '.sail', 'fake', 'harness.json');
  const script = JSON.parse(readFileSync(path, 'utf8'));
  script.spec = [change(script.spec[0]), ...script.spec.slice(1)];
  writeFileSync(path, `${JSON.stringify(script, null, 2)}\n`);
}

/** `sail run <args>` in `repo`, with the new run it left, if any: every run but the source. */
async function sailRun(repo: TempRepo, sourceId: string, args: string[], capture: CaptureOptions = {}) {
  const captured = await runCaptured(['run', ...args], repo.dir, { env: repo.env, ...capture });
  const [runId = ''] = runIds(repo.dir).filter((id) => id !== sourceId);
  return { ...captured, runId, dir: join(repo.dir, '.sail-runs', runId) };
}

test('a seeded run holds the keep-awake once and releases it at its end, with --continue or without', async () => {
  for (const extra of [[], ['--continue']]) {
    await withTempRepo(async (repo) => {
      const from = await source.copyInto(repo.dir);
      const { keepAwake, calls } = recordingKeepAwake();
      const ran = await sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec', ...extra], {
        keepAwake,
      });
      const held = readEvents(ran.dir).filter((event) => event.type === 'run:keep_awake');
      expect({ args: extra, calls }).toEqual({ args: extra, calls: ['acquire', 'release'] });
      expect(held).toEqual([expect.objectContaining({ held: true, by: 'fake' })]);
    });
  }
});

test('sail run --from-run --stage spec, after an edit of the spec prompt, reruns spec alone on the reused brief and stops suspended: its prompt carries the edit and its output is its own', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    edit(
      join(repo.dir, '.sail'),
      PROMPT,
      'Submit a one-sentence summary and the tasks.',
      `Submit a one-sentence summary and the tasks. ${EDIT}`,
    );
    answerSpec(repo.dir, (answer) => ({ ...answer, output: { ...(answer.output as object), summary: SUMMARY } }));
    const ran = await sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec']);
    expect({ code: ran.code, stderr: ran.stderr, end: ran.stdout.split('\n').at(-2) }).toEqual({
      code: EXIT_SUSPENDED,
      stderr: '',
      end: `resume it with: sail resume ${ran.runId}`,
    });
    const before = json(from.dir, '01-spec', 'call-1', 'result.json');
    const after = json(ran.dir, '01-spec', 'call-1', 'result.json');
    const consumed = Object.values(after.consumed as Record<string, string>);
    const prompt = (dir: string) => readFileSync(join(dir, '01-spec', 'call-1', 'prompt.md'), 'utf8');
    expect({
      fromRun: json(ran.dir, 'run.json').fromRun,
      consumed: after.consumed,
      hashes: consumed.map((path) => sha256(join(ran.dir, path))),
      promptChanged: prompt(ran.dir) !== prompt(from.dir),
      promptEdited: prompt(ran.dir).includes(EDIT),
      summary: [after.output.summary, before.output.summary === SUMMARY, after.runId],
      journal: readJournal(ran.dir).entries.map((entry) => entry.key),
    }).toEqual({
      fromRun: from.runId,
      consumed: before.consumed,
      hashes: consumed.map((path) => sha256(join(from.dir, path))),
      promptChanged: true,
      promptEdited: true,
      summary: [SUMMARY, false, ran.runId],
      journal: ['intake#1', 'spec#1'],
    });
  });
}, 60_000);

test('sail run --from-run --run-id starts the seeded run under exactly that id', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const id = 'FAKE-1-01HZX3Y4Z5A6B7C8D9E0F1G2H3';
    const ran = await sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec', '--run-id', id]);
    expect([ran.code, ran.runId, json(ran.dir, 'run.json').fromRun]).toEqual([EXIT_SUSPENDED, id, from.runId]);
  });
}, 60_000);

test('sail run --from-run with a --run-id of another ticket is refused with exit 3, one line, and starts no run', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const id = 'FAKE-2-01HZX3Y4Z5A6B7C8D9E0F1G2H3';
    const ran = await sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec', '--run-id', id]);
    expect([ran.code, ran.stdout, ran.stderr, runIds(repo.dir)]).toEqual([
      EXIT_REFUSED,
      '',
      `sail run: --run-id takes the id of a new run of FAKE-1, FAKE-1-<26 Crockford characters>: '${id}' is not one\n`,
      [from.runId],
    ]);
  });
}, 60_000);

test('sail run --from-run --stage spec --continue runs the seeded run to its end and exits 0', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const ran = await sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec', '--continue']);
    expect([ran.code, ran.stderr, ran.runId === '' ? undefined : readStatus(ran.dir)]).toEqual([
      EXIT_OK,
      '',
      { status: 'completed' },
    ]);
  });
}, 60_000);

test.each<[string, (runId: string) => string[], (dir: string) => void, (runId: string) => string]>([
  ['neither --from-run nor --stage', () => [], () => {}, () => USAGE],
  ['no --stage', (runId) => ['--from-run', runId], () => {}, () => USAGE],
  ['no --from-run', () => ['--stage', 'spec'], () => {}, () => USAGE],
  [
    'a run that does not exist',
    () => ['--from-run', 'FAKE-1-NOPE', '--stage', 'spec'],
    () => {},
    () => "sail run: no run 'FAKE-1-NOPE' in .sail-runs\n",
  ],
  [
    'a stage the workflow does not have',
    (runId) => ['--from-run', runId, '--stage', 'nope'],
    () => {},
    () => `sail run: --stage names 'nope', which is no stage of workflow 'ticket-to-pr': its stages are ${STAGES}\n`,
  ],
  [
    'a workflow that is gone',
    (runId) => ['--from-run', runId, '--stage', 'spec'],
    (dir) => rmSync(join(dir, '..', '..', '.sail', 'workflows', 'ticket-to-pr'), { recursive: true }),
    () => "sail run: no workflow 'ticket-to-pr': .sail/workflows/ticket-to-pr/workflow.ts doesn't exist\n",
  ],
  [
    'a stage the source never ran',
    (runId) => ['--from-run', runId, '--stage', 'publish'],
    (dir) => cutJournal(dir, 2),
    (runId) => `sail run: run ${runId} never ran 'publish': sail resume ${runId} continues it\n`,
  ],
])(
  'sail run with %s is refused with exit 3, and starts no run',
  async (_, args, prepare, refusal) => {
    await withTempRepo(async (repo) => {
      const from = await source.copyInto(repo.dir);
      prepare(from.dir);
      const ran = await sailRun(repo, from.runId, args(from.runId));
      expect([ran.code, ran.stdout, ran.stderr, runIds(repo.dir)]).toEqual([
        EXIT_REFUSED,
        '',
        refusal(from.runId),
        [from.runId],
      ]);
    });
  },
  60_000,
);

test('sail run on a workflow with a type error prints it where it is, then is refused with exit 3, and starts no run', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    edit(
      join(repo.dir, '.sail'),
      WORKFLOW,
      "import { workflow } from 'sail';",
      "import { workflow } from 'sail';\nconst bad: number = 'x';\nexport const unused = bad;",
    );
    const ran = await sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec']);
    const [diagnostic, refusal, ...rest] = ran.stderr.split('\n');
    expect([ran.code, ran.stdout, refusal, rest, runIds(repo.dir)]).toEqual([
      EXIT_REFUSED,
      '',
      'sail run: 1 type error in .sail/workflows/ticket-to-pr/workflow.ts',
      [''],
      [from.runId],
    ]);
    expect(diagnostic).toMatch(/^\.sail\/workflows\/ticket-to-pr\/workflow\.ts:\d+:\d+ {2}TS2322 {2}/);
  });
}, 60_000);

test('Ctrl-C before the seeded run opens is a refusal that starts no run', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    // Interrupted as soon as the command listens: before the run is opened.
    const onInterrupt: CaptureOptions['onInterrupt'] = (handler) => {
      handler();
      return () => {};
    };
    const ran = await sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec'], { onInterrupt });
    expect([ran.code, ran.stderr, runIds(repo.dir)]).toEqual([
      EXIT_REFUSED,
      'sail run: stopped before the run was opened\n',
      [from.runId],
    ]);
  });
}, 60_000);

test('Ctrl-C during the spec session suspends the seeded run with interrupted, and says how to resume it', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    answerSpec(repo.dir, (answer) => ({ ...answer, delayMs: 30_000 }));
    const interrupts = fakeInterrupts();
    const running = sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec'], interrupts);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    const deadline = performance.now() + 30_000;
    while (!settled && performance.now() < deadline) {
      const [runId] = runIds(repo.dir).filter((id) => id !== from.runId);
      const dir = join(repo.dir, '.sail-runs', runId ?? '');
      if (runId !== undefined && existsSync(join(dir, 'events.ndjson'))) {
        if (readEvents(dir).some((event) => event.type === 'harness:session_start')) break;
      }
      await Bun.sleep(20);
    }
    interrupts.interrupt();
    const ran = await running;
    expect([ran.code, ran.stdout.split('\n').at(-2), ran.runId === '' ? undefined : readStatus(ran.dir)]).toEqual([
      EXIT_SUSPENDED,
      `resume it with: sail resume ${ran.runId}`,
      { status: 'suspended', stopReason: 'interrupted' },
    ]);
  });
}, 60_000);

test('the usage lists sail run --from-run and what --continue does, and still lists sail <ticket> first', async () => {
  const { stdout } = await runCaptured(['--help']);
  const commands = stdout.split('\n').filter((line) => line.startsWith('  sail '));
  expect(commands[0]).toBe('  sail <ticket> [--workflow <name>] [--force] [--until <stage>] [-q|-v|-vv]');
  expect(stdout).toMatch(
    /^ {2}sail run --from-run <run> --stage <stage> \[--continue\] \[--run-id <id>\]\n {2,}Rerun one stage on another run's earlier calls: a seeded run$/m,
  );
  expect(stdout).toMatch(/^ {2}--run-id {4}Names the new run, ready to be told before it exists: /m);
  expect(stdout).toMatch(
    /^A seeded run:\n {2}--continue {2,}Runs the rest of the workflow after the stage, not just the stage$/m,
  );
});

// Review round 1: a source whose run.json can't be read is refused in the engine's words, not thrown on.
test('sail run from a source whose run.json is broken is refused with exit 3, and starts no run', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    chmodSync(join(from.dir, 'run.json'), 0o644);
    writeFileSync(join(from.dir, 'run.json'), '{');
    const ran = await sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec']);
    const refusal = `sail run: run ${from.runId}'s run.json can't be read: `;
    expect([ran.code, ran.stdout, ran.stderr.startsWith(refusal) ? refusal : ran.stderr, runIds(repo.dir)]).toEqual([
      EXIT_REFUSED,
      '',
      refusal,
      [from.runId],
    ]);
  });
}, 60_000);

// Review round 2: the repository is registered once the seeded run opens, so a refusal writes nothing.
test('a refused sail run leaves the machine registry unwritten, and a seeded run that opens registers the repository', async () => {
  /** `sail run` with `args` in a copy of the source, and whether the machine registry exists afterwards. */
  const registered = (args: (runId: string) => string[]) =>
    withTempRepo(async (repo) => {
      const from = await source.copyInto(repo.dir);
      const registry = join(repo.home, '.sail');
      const env = { ...repo.env, SAIL_HOME: registry };
      const ran = await sailRun(repo, from.runId, args(from.runId), { env });
      return [ran.code, existsSync(registry)];
    });
  expect([
    await registered((runId) => ['--from-run', runId, '--stage', 'nope']),
    await registered((runId) => ['--from-run', runId, '--stage', 'spec']),
  ]).toEqual([
    [EXIT_REFUSED, false],
    [EXIT_SUSPENDED, true],
  ]);
}, 60_000);

test('sail run --from-run masks credentials from its own io.env in run.json and in the calls it runs', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const marker = 'ghp_SEEDED_MARKER_0123456789';
    answerSpec(repo.dir, (answer) => ({ ...answer, messages: [`echo ${marker}`] }));
    const ran = await sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec'], {
      env: { ...repo.env, SAIL_TEST_TOKEN: marker, SAIL_ORIGIN_TOKEN: 'fake://origin' },
    });
    expect(ran.code).toBe(EXIT_SUSPENDED);
    expect(ran.stdout.includes(marker)).toBe(false);
    expect(json(ran.dir, 'run.json').repository.url).toBe('[redacted]');
    expect(readFileSync(join(ran.dir, '01-spec', 'call-1', 'session.log'), 'utf8')).toBe(
      'assistant: echo [redacted]\n',
    );
    const files = readdirSync(ran.dir, { recursive: true, withFileTypes: true }).filter(
      // definition/ is a copy of the repository's own files, which hold the marker as written.
      (file) => file.isFile() && !relative(ran.dir, file.parentPath).startsWith('definition'),
    );
    expect(
      files
        .filter((file) => readFileSync(join(file.parentPath, file.name), 'utf8').includes(marker))
        .map((file) => file.name),
    ).toEqual([]);
  });
});
