// `sail run --from-run <run> --stage <stage> [--continue]`, in process through run(), on copies of the fixture
// repository. The source is `sail FAKE-1` run to its end once in a repository of its own, and each case copies it into
// its own: a process opens one run per `.sail/`. The fake harness answers by call key, not by prompt, so a changed
// answer in `.sail/fake/harness.json` stands in for the different output an edited prompt would get (DECISIONS D10).
import { afterAll, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { EXIT_OK, EXIT_REFUSED, EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { readJournal } from '../../src/engine/journal';
import { recordingKeepAwake } from '../../src/engine/keep-awake';
import { readStatus } from '../../src/engine/run-dir';
import { readEvents } from '../../src/events/consumers/ndjson';
import { fakeCredentialTools } from '../helpers/fake-credentials';
import { copyFixture, edit, FIXTURE_SAIL, patchTicket } from '../helpers/fixture';
import { type CaptureOptions, fakeInterrupts, runCaptured } from '../helpers/run-captured';
import { cutJournal, pushedSource, runIds, sharedSource } from '../helpers/seeded';
import { copyRun } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const source = sharedSource();
afterAll(() => source.release());

const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';
const OPEN = 'workflows/ticket-to-pr/stages/publish/open.sh';
const PROMPT = 'workflows/ticket-to-pr/stages/spec/prompt.md';
const EDIT = 'Keep the spec to one page.';
const SUMMARY = 'Add --shout to greet() and the CLI, upper-casing the whole line.';
const USAGE = 'sail run: usage: sail run --from-run <run> --stage <stage> [--continue] [--from-base] [--run-id <id>]\n';
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

test('a seeded run of a ticket that has gained an open prerequisite starts: a seeded run checks no prerequisites', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    patchTicket(join(repo.dir, '.sail'), 'FAKE-1', { prerequisites: ['FAKE-2'] });
    const ran = await sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec']);
    expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: EXIT_SUSPENDED, stderr: '' });
    expect(ran.runId).not.toBe('');
  });
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

test('the usage lists sail run --from-run and what --continue and --from-base do, and still lists sail <ticket> first', async () => {
  const { stdout } = await runCaptured(['--help']);
  const commands = stdout.split('\n').filter((line) => line.startsWith('  sail '));
  expect(commands[0]).toBe(
    '  sail <ticket> [--workflow <name>] [--force] [--ignore-prerequisites] [--until <stage>] [--run-id <id>] [-q|-v|-vv]',
  );
  expect(stdout).toMatch(
    /^ {2}sail run --from-run <run> --stage <stage> \[--continue\] \[--from-base\] \[--run-id <id>\]\n {2,}Rerun one stage on another run's earlier calls: a seeded run$/m,
  );
  expect(stdout).toMatch(
    /^ {2}--run-id {4}Names the new run \(also of sail <ticket>\), ready to be told before it exists: /m,
  );
  expect(stdout).toMatch(
    /^A seeded run:\n {2}--continue {2,}Runs the rest of the workflow after the stage, not just the stage\n {2}--from-base Starts the workspace at the source run's base, not from the commits it made$/m,
  );
});

test("sail run --from-run --from-base starts at the source's base though the source left a run ref, and without it carries the ref", async () => {
  /** The `repository` of the header of a seeded run of a source that left one commit at its run ref, and that commit. */
  const seededWith = (flags: string[]) =>
    withTempRepo(async (repo) => {
      const from = await source.copyInto(repo.dir);
      const base: string = json(from.dir, 'run.json').repository.baseSha;
      const tip = repo.git('commit-tree', `${base}^{tree}`, '-p', base, '-m', 'task 1');
      repo.git('update-ref', `refs/sail/runs/${from.runId}`, tip);
      const ran = await sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec', ...flags]);
      return { code: ran.code, base, tip, repository: json(ran.dir, 'run.json').repository };
    });
  const carried = await seededWith([]);
  const fromBase = await seededWith(['--from-base']);
  expect({
    codes: [carried.code, fromBase.code],
    carried: carried.repository,
    fromBase: fromBase.repository,
  }).toEqual({
    codes: [EXIT_SUSPENDED, EXIT_SUSPENDED],
    carried: expect.objectContaining({ baseSha: carried.base, startSha: carried.tip }),
    fromBase: expect.objectContaining({ baseSha: fromBase.base }),
  });
  expect(fromBase.repository.startSha).toBeUndefined();
}, 90_000);

test('sail run --from-run of a source that pushed its branch and then failed carries the pushed commits, with --continue or without', async () => {
  const carried = async (flags: string[]) =>
    withTempRepo(async (first) => {
      const { runId, base, head } = await pushedSource(first);
      return withTempRepo(async (second) => {
        copyRun(first.dir, second.dir);
        // With --continue the run reaches publish again, which must pass this time: the fixture's own open step.
        if (flags.length > 0) copyFileSync(join(FIXTURE_SAIL, OPEN), join(second.dir, '.sail', OPEN));
        const ran = await sailRun(second, runId, ['--from-run', runId, '--stage', 'spec', ...flags]);
        const { baseSha, startSha } = json(ran.dir, 'run.json').repository;
        return { code: ran.code, repository: { baseSha, startSha }, expected: { baseSha: base, startSha: head } };
      });
    });
  const [plain, continued] = [await carried([]), await carried(['--continue'])];
  expect([plain.code, continued.code]).toEqual([EXIT_SUSPENDED, EXIT_OK]);
  expect(plain.repository).toEqual(plain.expected);
  expect(continued.repository).toEqual(continued.expected);
}, 120_000);

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

const OAUTH = 'oauth-from-the-keychain-0123';

/**
 * The repository's harness made one that requires a Claude credential, as claude-code does: it answers each call with
 * the first answer of its stage in the fake script, echoes the token it was created with in its message and transcript,
 * as a session that leaks it would, and leaves that token in `token.txt`.
 */
function keyedHarness(repoDir: string): void {
  const sail = join(repoDir, '.sail');
  writeFileSync(
    join(sail, 'adapters', 'keyed-harness.ts'),
    `import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default {
  requires: () => [['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']],
  create: (_options: unknown, context: { root: string; sailDir: string; env: Record<string, string | undefined> }) => {
    writeFileSync(join(context.root, 'token.txt'), context.env.CLAUDE_CODE_OAUTH_TOKEN ?? '');
    const script = JSON.parse(readFileSync(join(context.sailDir, 'fake', 'harness.json'), 'utf8'));
    return {
      name: 'keyed',
      capabilities: () => ({ structuredOutput: true, permissions: true, usage: true, abort: true, budgets: [] }),
      run: async (request: { key: string; env: Record<string, string>; onEvent?: (event: unknown) => void }) => {
        const token = context.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
        const answer = (script[request.key] ?? script[request.key.replace(/#\\d+/, '')])[0];
        for (const [name, text] of Object.entries(answer.files ?? {})) writeFileSync(join(request.env.STAGE_OUT, name), text as string);
        request.onEvent?.({ type: 'agent:message', text: \`echo \${token}\` });
        return {
        outcome: 'done',
        output: answer.output,
        sessionId: 'keyed-1',
        usage: { costUsd: 0 },
        transcript: \`assistant: echo \${token}\\n\`,
        raw: null,
        };
      },
    };
  },
};
`,
  );
  edit(sail, 'project.yaml', 'harness: { use: fake }', 'harness: { use: ./adapters/keyed-harness.ts }');
}

/** An environment with no Claude credential, the lookup on, and fake tools whose keychain holds `items`. */
function keychainEnv(repo: TempRepo, items: Record<string, string>): Record<string, string> {
  const { ANTHROPIC_API_KEY: _key, CLAUDE_CODE_OAUTH_TOKEN: _token, ...env } = repo.env;
  const dir = mkdtempSync(join(tmpdir(), 'sail-test-tools-'));
  toolDirs.push(dir);
  return { ...env, SAIL_CREDENTIAL_LOOKUP: 'on', PATH: fakeCredentialTools(dir, { items }, env.PATH) };
}

const toolDirs: string[] = [];
afterAll(() => {
  for (const dir of toolDirs) rmSync(dir, { recursive: true, force: true });
});

test('sail run --from-run --stage spec starts from an environment with no Claude credential, reading claude-oauth-token from the keychain, and the token is in no file of the run', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    mkdirSync(join(repo.dir, '.sail', 'adapters'), { recursive: true });
    keyedHarness(repo.dir);
    const env = keychainEnv(repo, { 'claude-oauth-token': OAUTH });
    const ran = await sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec'], { env });
    expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: EXIT_SUSPENDED, stderr: '' });
    expect(readFileSync(join(repo.dir, 'token.txt'), 'utf8')).toBe(OAUTH);
    const held = readdirSync(ran.dir, { recursive: true, withFileTypes: true })
      .filter((file) => file.isFile() && !relative(ran.dir, file.parentPath).startsWith('definition'))
      .filter((file) => readFileSync(join(file.parentPath, file.name), 'utf8').includes(OAUTH));
    expect(held.map((file) => file.name)).toEqual([]);
    expect(readFileSync(join(ran.dir, '01-spec', 'call-1', 'session.log'), 'utf8')).toContain(
      'assistant: echo [redacted]',
    );
  });
}, 60_000);

test('sail FAKE-1 and sail resume from an environment with no Claude credential mask the token read from the keychain in what the session echoes', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    mkdirSync(join(repo.dir, '.sail', 'adapters'), { recursive: true });
    keyedHarness(repo.dir);
    const env = keychainEnv(repo, { 'claude-oauth-token': OAUTH });
    const started = await runCaptured(['FAKE-1', '--until', 'spec'], repo.dir, { env });
    expect({ code: started.code, stderr: started.stderr }).toEqual({ code: EXIT_SUSPENDED, stderr: '' });
    const [runId = ''] = runIds(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const unmasked = () =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((file) => file.isFile() && !relative(dir, file.parentPath).startsWith('definition'))
        .filter((file) => readFileSync(join(file.parentPath, file.name), 'utf8').includes(OAUTH))
        .map((file) => relative(dir, join(file.parentPath, file.name)));
    expect(started.stdout).not.toContain(OAUTH);
    expect(unmasked()).toEqual([]);
    expect(readFileSync(join(dir, '01-spec', 'call-1', 'session.log'), 'utf8')).toContain('assistant: echo [redacted]');
    const resumed = await runCaptured(['resume', runId], repo.dir, { env });
    expect({ code: resumed.code, stderr: resumed.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(resumed.stdout).not.toContain(OAUTH);
    expect(unmasked()).toEqual([]);
    expect(readFileSync(join(dir, '02-implement', 'call-1', 'session.log'), 'utf8')).toContain(
      'assistant: echo [redacted]',
    );
  });
}, 60_000);

test('sail run --from-run with no Claude credential and no claude-oauth-token item is refused with exit 3 naming the item, and starts no run', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    mkdirSync(join(repo.dir, '.sail', 'adapters'), { recursive: true });
    keyedHarness(repo.dir);
    const env = keychainEnv(repo, {});
    const ran = await sailRun(repo, from.runId, ['--from-run', from.runId, '--stage', 'spec'], { env });
    expect({ code: ran.code, run: ran.runId, stderr: ran.stderr }).toEqual({
      code: EXIT_REFUSED,
      run: '',
      stderr:
        '.sail/project.yaml  /adapters/harness needs one of ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, none of which is set, and the keychain holds no claude-oauth-token item\n',
    });
  });
}, 60_000);
