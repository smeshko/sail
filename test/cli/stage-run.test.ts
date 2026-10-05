// `sail stage run`, in process through run(): one script stage, run in isolation from its stage directory.
import { expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { type Io, run } from '../../src/cli/index';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import { SPEC, SPEC_STAGE, submits, TICKET, writeAgentFixture } from '../helpers/agent-fixture';
import { edit, write } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const root = join(import.meta.dir, '..', '..');
const inRepoFixture = join(root, 'test', 'fixtures', 'repo');
const USAGE = 'sail stage run: usage: sail stage run <stage-dir> [--bind name=value]...\n';

/** The call directory a run printed, as an absolute path. */
function callDirOf(stdout: string, cwd: string): string {
  const printed = stdout.split('\n')[0]?.split('  ')[1];
  if (printed === undefined) throw new Error(`no call directory in: ${stdout}`);
  return join(cwd, printed);
}

function readResult(callDir: string): Record<string, unknown> {
  const result = JSON.parse(readFileSync(join(callDir, 'result.json'), 'utf8'));
  expect(validateDocument('sail.result.v1', result).map(formatIssue)).toEqual([]);
  return result;
}

/** A copy of the fixture's .sail/ plus a `bound` stage that takes a file and a value, and echoes where they are. */
function fixtureCopy(repo: TempRepo): string {
  const sail = join(repo.dir, '.sail');
  cpSync(join(inRepoFixture, '.sail'), sail, { recursive: true });
  const bound = join(sail, 'stages', 'bound');
  mkdirSync(bound);
  writeFileSync(
    join(bound, 'stage.ts'),
    `import { file, script, value, z } from 'sail';

export const bound = script('bound', {
  run: './run.sh',
  consumes: { spec: file('spec.md'), ticket: value(z.object({ key: z.string() })) },
  output: z.object({ spec: z.string(), ticket: z.string(), specText: z.string() }),
});
`,
  );
  writeScript(
    join(bound, 'run.sh'),
    'printf \'{"spec":"%s","ticket":"%s","specText":"%s"}\\n\' "$INPUT_SPEC" "$INPUT_TICKET" "$(cat "$INPUT_SPEC")"',
  );
  mkdirSync(join(repo.dir, 'docs'));
  writeFileSync(join(repo.dir, 'docs', 'spec.md'), 'the spec');
  return sail;
}

function writeScript(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

test('the fixture tests stage runs in place from sail’s root, and passes', async () => {
  const runs = join(inRepoFixture, '.sail-runs');
  const existing = existsSync(runs) ? readdirSync(runs) : [];
  let callDir: string | undefined;
  try {
    const { code, stdout, stderr } = await runCaptured(['stage', 'run', 'test/fixtures/repo/.sail/stages/tests'], root);
    console.log(stdout.trimEnd());
    expect(stderr).toBe('');
    expect(code).toBe(EXIT_OK);
    expect(stdout).toMatch(
      /^tests#1 passed {2}test\/fixtures\/repo\/\.sail-runs\/tests-[0-9A-HJKMNP-TV-Z]{26}\/00-tests\/call-1\n$/,
    );
    callDir = callDirOf(stdout, root);
    expect(readdirSync(callDir).sort()).toEqual(['in', 'junit.xml', 'result.json', 'stderr.log', 'stdout.log']);
    expect(readResult(callDir)).toMatchObject({
      key: 'tests#1',
      outcome: 'passed',
      command: '.sail/stages/tests/run.sh',
    });
  } finally {
    if (callDir !== undefined) rmSync(join(callDir, '..', '..'), { recursive: true, force: true });
    if (existing.length === 0 && existsSync(runs) && readdirSync(runs).length === 0) rmdirSync(runs);
  }
});

test('a stage that binds a file and a value runs from a subdirectory, with both under $STAGE_IN', async () => {
  await withTempRepo(async (repo) => {
    fixtureCopy(repo);
    const cwd = join(repo.dir, 'src', 'deep');
    mkdirSync(cwd, { recursive: true });
    const argv = [
      'stage',
      'run',
      '../../.sail/stages/bound',
      '--bind',
      'spec=../../docs/spec.md',
      '--bind',
      'ticket={"key":"FAKE-1"}',
    ];
    const { code, stdout, stderr } = await runCaptured(argv, cwd);
    expect(stderr).toBe('');
    expect(code).toBe(EXIT_OK);
    expect(stdout).toStartWith('bound#1 passed  ../../.sail-runs/bound-');
    const callDir = callDirOf(stdout, cwd);
    const result = readResult(callDir);
    expect(result.output).toEqual({
      spec: join(callDir, 'in', 'spec.md'),
      ticket: join(callDir, 'in', 'ticket.json'),
      specText: 'the spec',
    });
    expect(result.consumed).toEqual({ spec: 'docs/spec.md', ticket: '--bind' });
    expect(JSON.parse(readFileSync(join(callDir, 'in', 'ticket.json'), 'utf8'))).toEqual({ key: 'FAKE-1' });
  });
});

test.each([
  ['a private stage runs from its folder', 'workflows/ticket-to-pr/stages/tests'],
  ['a numbered stage folder runs under its stage name', 'stages/10-tests'],
])('%s', async (_, folder) => {
  await withTempRepo(async (repo) => {
    const sail = fixtureCopy(repo);
    renameSync(join(sail, 'stages', 'tests'), join(sail, folder));
    const { code, stdout, stderr } = await runCaptured(['stage', 'run', `.sail/${folder}`], repo.dir);
    expect(stderr).toBe('');
    expect(code).toBe(EXIT_OK);
    expect(stdout).toMatch(/^tests#1 passed {2}\.sail-runs\/tests-[0-9A-HJKMNP-TV-Z]{26}\/00-tests\/call-1\n$/);
    expect(readResult(callDirOf(stdout, repo.dir))).toMatchObject({
      key: 'tests#1',
      outcome: 'passed',
      command: `.sail/${folder}/run.sh`,
    });
  });
});

test('failed and error exit 1, and print each error with its reason', async () => {
  await withTempRepo(async (repo) => {
    const sail = fixtureCopy(repo);
    const runSh = join(sail, 'stages', 'tests', 'run.sh');
    writeScript(
      runSh,
      'echo "<x/>" > "$STAGE_OUT/junit.xml"\necho \'{"ok":false,"total":1,"failed":1,"durationMs":1,"failures":[]}\'\nexit 1',
    );
    const failed = await runCaptured(['stage', 'run', '.sail/stages/tests'], repo.dir);
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.stdout).toStartWith('tests#1 failed  .sail-runs/tests-');

    writeScript(runSh, 'echo \'{"ok":true}\'');
    const error = await runCaptured(['stage', 'run', '.sail/stages/tests'], repo.dir);
    console.log(error.stdout.trimEnd());
    expect(error.code).toBe(EXIT_FAILED);
    const [first, ...rest] = error.stdout.trimEnd().split('\n');
    expect(first).toStartWith('tests#1 error  .sail-runs/tests-');
    expect(rest[0]).toBe("  invalid_output  the output doesn't match its schema:");
    expect(rest[1]).toBe('                  ✖ Invalid input: expected number, received undefined');
    expect(rest[2]).toBe('                    → at total');
    expect(rest.at(-1)).toBe("  missing_file  'junit.xml' was not produced in $STAGE_OUT");
  });
});

test('a type error in an unrelated workflow does not stop the stage', async () => {
  await withTempRepo(async (repo) => {
    const sail = fixtureCopy(repo);
    const workflow = join(sail, 'workflows', 'ticket-to-pr', 'workflow.ts');
    writeFileSync(
      workflow,
      readFileSync(workflow, 'utf8').replace("s.files['spec.md'], feedback", 'run.input, feedback'),
    );
    expect((await runCaptured(['check'], repo.dir)).code).toBe(EXIT_REFUSED);
    expect((await runCaptured(['stage', 'run', '.sail/stages/tests'], repo.dir)).code).toBe(EXIT_OK);
  });
});

test('a script that clears $STAGE_OUT first still gets a result.json, naming the removed log', async () => {
  await withTempRepo(async (repo) => {
    const sail = fixtureCopy(repo);
    const runSh = join(sail, 'stages', 'tests', 'run.sh');
    writeFileSync(
      runSh,
      readFileSync(runSh, 'utf8').replace('set -euo pipefail\n', 'set -euo pipefail\nrm -rf "$STAGE_OUT"/*\n'),
    );
    const { code, stdout, stderr } = await runCaptured(['stage', 'run', '.sail/stages/tests'], repo.dir);
    console.log(stdout.trimEnd());
    expect(stderr).toBe('');
    expect(code).toBe(EXIT_FAILED);
    expect(readResult(callDirOf(stdout, repo.dir))).toMatchObject({
      outcome: 'error',
      errors: [
        { reason: 'invalid_output', message: "stdout.log was removed from $STAGE_OUT, so the output can't be read" },
      ],
      files: { 'junit.xml': { path: '00-tests/call-1/junit.xml' } },
    });
  });
});

test('Ctrl+C stops the script, and the command ends with the signal recorded', async () => {
  await withTempRepo(async (repo) => {
    const sail = fixtureCopy(repo);
    writeScript(join(sail, 'stages', 'tests', 'run.sh'), 'sleep 30');
    let stdout = '';
    let unregistered = false;
    let interruptedAt = 0;
    const io: Io = {
      cwd: repo.dir,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      onInterrupt: (handler) => {
        setTimeout(() => {
          interruptedAt = performance.now();
          handler();
        }, 300);
        return () => {
          unregistered = true;
        };
      },
    };
    const code = await run(['stage', 'run', '.sail/stages/tests'], io);
    const ms = performance.now() - interruptedAt;
    console.log(`interrupt to exit: ${Math.round(ms)} ms`);
    expect(code).toBe(EXIT_FAILED);
    expect(ms).toBeLessThan(5000);
    expect(unregistered).toBe(true);
    expect(readResult(callDirOf(stdout, repo.dir))).toMatchObject({
      outcome: 'error',
      exit: { code: null, signal: 'SIGTERM' },
      errors: [{ reason: 'exit_code', message: 'interrupted, then ended by signal SIGTERM' }],
    });
  });
});

test.each([
  ['an unknown binding', ['--bind', 'nope=1'], "  'nope' is not a binding of this stage"],
  ['a binding named __proto__', ['--bind', '__proto__=1'], "  '__proto__' is not a binding of this stage"],
  ['a missing required binding', ['--bind', 'spec=docs/spec.md'], "  'ticket' is required"],
  [
    'a value its schema rejects',
    ['--bind', 'spec=docs/spec.md', '--bind', 'ticket={"key":1}'],
    "  'ticket': ✖ Invalid input: expected string, received number",
  ],
  [
    'a bound file that is missing',
    ['--bind', 'spec=docs/nope.md', '--bind', 'ticket={"key":"A"}'],
    "  'spec': no file at ",
  ],
])('%s is refused, and leaves no run directory', async (_, binds, problem) => {
  await withTempRepo(async (repo) => {
    fixtureCopy(repo);
    const { code, stdout, stderr } = await runCaptured(['stage', 'run', '.sail/stages/bound', ...binds], repo.dir);
    expect(code).toBe(EXIT_REFUSED);
    expect(stdout).toBe('');
    expect(stderr).toStartWith(`sail stage run: bound can't run:\n${problem}`);
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test.each([
  [
    'a --bind without =',
    ['.sail/stages/bound', '--bind', 'spec'],
    "sail stage run: --bind 'spec' has no '=': use --bind name=value\n",
  ],
  [
    'a value that is not JSON',
    ['.sail/stages/bound', '--bind', 'ticket={key}'],
    "sail stage run: 'ticket': not JSON: ",
  ],
  [
    'a binding given twice',
    ['.sail/stages/bound', '--bind', 'ticket=1', '--bind', 'ticket=2'],
    "sail stage run: 'ticket' is bound twice\n",
  ],
  [
    'the multi-step stage publish',
    ['.sail/workflows/ticket-to-pr/stages/publish'],
    "sail stage run: publish can't run:\n  multi-step stages can't run yet\n",
  ],
  ['a directory without stage.ts', ['.sail/stages'], 'sail stage run: no stage.ts in .sail/stages\n'],
])('%s is refused', async (_, argv, message) => {
  await withTempRepo(async (repo) => {
    fixtureCopy(repo);
    const { code, stdout, stderr } = await runCaptured(['stage', 'run', ...argv], repo.dir);
    expect(code).toBe(EXIT_REFUSED);
    expect(stdout).toBe('');
    expect(stderr).toStartWith(message);
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test.each([['docs'], ['.sail'], ['.sail/workflows/ticket-to-pr'], ['.sail/misc/x']])(
  '%s, holding a stage.ts, is refused as not a stage folder',
  async (dir) => {
    await withTempRepo(async (repo) => {
      fixtureCopy(repo);
      mkdirSync(join(repo.dir, dir), { recursive: true });
      writeFileSync(join(repo.dir, dir, 'stage.ts'), '');
      expect(await runCaptured(['stage', 'run', dir], repo.dir)).toEqual({
        code: EXIT_REFUSED,
        stdout: '',
        stderr:
          `sail stage run: ${dir} is not a stage folder: stages live in .sail/stages/<stage>/ or ` +
          '.sail/workflows/<workflow>/stages/<stage>/\n',
      });
      expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
    });
  },
);

test("a type error in the stage's own files is refused before it runs", async () => {
  await withTempRepo(async (repo) => {
    const sail = fixtureCopy(repo);
    const stageFile = join(sail, 'stages', 'tests', 'stage.ts');
    writeFileSync(stageFile, readFileSync(stageFile, 'utf8').replace("run: './run.sh'", 'run: 42'));
    const { code, stdout, stderr } = await runCaptured(['stage', 'run', '.sail/stages/tests'], repo.dir);
    expect(code).toBe(EXIT_REFUSED);
    expect(stdout).toBe('');
    expect(stderr).toContain('.sail/stages/tests/stage.ts:');
    expect(stderr).toContain('TS2322');
    expect(stderr).toEndWith('sail stage run: 1 type error in .sail/stages/tests/stage.ts\n');
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test('a stage named unlike its folder is refused, as sail check refuses it', async () => {
  await withTempRepo(async (repo) => {
    const stageFile = join(fixtureCopy(repo), 'stages', 'tests', 'stage.ts');
    writeFileSync(stageFile, readFileSync(stageFile, 'utf8').replace("script('tests',", "script('other',"));
    expect(await runCaptured(['stage', 'run', '.sail/stages/tests'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr:
        "sail stage run: .sail/stages/tests/stage.ts: declares stage 'other', but its folder tests/ says 'tests'\n",
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test('a stage.ts that throws on import, or exports no single definition, is refused', async () => {
  await withTempRepo(async (repo) => {
    const sail = fixtureCopy(repo);
    const stageFile = join(sail, 'stages', 'tests', 'stage.ts');
    const text = readFileSync(stageFile, 'utf8');
    writeFileSync(stageFile, `${text}\nthrow new Error('boom');\n`);
    expect(await runCaptured(['stage', 'run', '.sail/stages/tests'], repo.dir)).toMatchObject({
      code: EXIT_REFUSED,
      stderr: 'sail stage run: .sail/stages/tests/stage.ts: boom\n',
    });
    const bound = join(sail, 'stages', 'bound', 'stage.ts');
    writeFileSync(
      bound,
      `${readFileSync(bound, 'utf8')}\nexport const other = script('other', { run: './run.sh', output: z.object({}) });\n`,
    );
    expect(await runCaptured(['stage', 'run', '.sail/stages/bound'], repo.dir)).toMatchObject({
      code: EXIT_REFUSED,
      stderr:
        'sail stage run: .sail/stages/bound/stage.ts: exports 2 stage definitions (bound, other), and a stage.ts ' +
        'exports exactly one\n',
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test('a missing project.yaml, or no .sail/ at all, is refused', async () => {
  await withTempRepo(async (repo) => {
    const sail = fixtureCopy(repo);
    rmSync(join(sail, 'project.yaml'));
    expect(await runCaptured(['stage', 'run', '.sail/stages/tests'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: '.sail/project.yaml  [sail.project.v1]  / is missing\n',
    });
    rmSync(sail, { recursive: true });
    mkdirSync(join(repo.dir, 'stages', 'x'), { recursive: true });
    writeFileSync(join(repo.dir, 'stages', 'x', 'stage.ts'), '');
    expect(await runCaptured(['stage', 'run', 'stages/x'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: `sail stage run: no .sail/ between ${join(repo.dir, 'stages', 'x')} and the git root ${repo.dir}\n`,
    });
  });
});

test.each([[['stage']], [['stage', 'run']], [['stage', 'walk', 'x']]])(
  '%p is refused with the usage line',
  async (argv) => {
    expect(await runCaptured(argv)).toEqual({ code: EXIT_REFUSED, stdout: '', stderr: USAGE });
  },
);

test('a sail range the running version does not satisfy is refused before anything is written', async () => {
  await withTempRepo(async (repo) => {
    const project = join(fixtureCopy(repo), 'project.yaml');
    writeFileSync(project, readFileSync(project, 'utf8').replace('>=0.0.0 <1', '>=1.0 <2'));
    expect(await runCaptured(['stage', 'run', '.sail/stages/tests'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: `.sail/project.yaml  /sail is '>=1.0 <2', which sail ${pkg.version} doesn't satisfy\n`,
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

// Agent stages in isolation: brief-to-spec's spec stage on the fake harness, whose script says what its session does.

/** `sail stage run` of the fixture's spec stage, with a brief and the ticket bound. */
const SPEC_ARGV = [
  'stage',
  'run',
  `.sail/${SPEC_STAGE}`,
  '--bind',
  'brief=docs/brief.md',
  '--bind',
  `ticket=${JSON.stringify(TICKET)}`,
];
const SPEC_RUN = String.raw`\.sail-runs\/spec-[0-9A-HJKMNP-TV-Z]{26}\/00-spec\/call-1`;

/** The agent fixture in `repo`, its harness scripted with `answers`, and a brief to bind. Returns its `.sail/`. */
function agentRepo(repo: TempRepo, answers: Parameters<typeof writeAgentFixture>[1]): string {
  write(repo.dir, 'docs/brief.md', '# Brief\n');
  return writeAgentFixture(repo.dir, answers);
}

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ("the fixture's agent stage spec, given no brief, is refused for its binding, and leaves no run directory", async () => {
  await withTempRepo(async (repo) => {
    fixtureCopy(repo);
    const argv = ['stage', 'run', '.sail/workflows/ticket-to-pr/stages/spec'];
    expect(await runCaptured(argv, repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: "sail stage run: spec can't run:\n  'brief' is required\n",
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('an agent stage runs in isolation on the harness project.yaml names and the model its alias names: done exits 0, and leaves its prompt, transcript and result', async () => {
  await withTempRepo(async (repo) => {
    agentRepo(repo, [submits(SPEC, 0.25)]);
    const { code, stdout, stderr } = await runCaptured(SPEC_ARGV, repo.dir);
    expect(stderr).toBe('');
    expect(code).toBe(EXIT_OK);
    expect(stdout).toMatch(new RegExp(`^spec#1 done {2}${SPEC_RUN}\n$`));
    const callDir = callDirOf(stdout, repo.dir);
    expect(readdirSync(callDir).sort()).toEqual(['in', 'prompt.md', 'result.json', 'session.log', 'spec.md']);
    expect(readdirSync(join(callDir, 'in')).sort()).toEqual(['brief.md', 'ticket.json']);
    expect(readResult(callDir)).toMatchObject({
      key: 'spec#1',
      outcome: 'done',
      output: SPEC,
      consumed: { brief: 'docs/brief.md', ticket: '--bind' },
      harness: { adapter: 'fake', model: 'claude-opus-5-5' },
    });
    expect(readFileSync(join(callDir, 'session.log'), 'utf8').trimEnd()).toBe('assistant: Spec written.');
  });
}, 20_000);

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('a blocked agent stage exits 1 and prints its reason, and one that ends in error exits 1 and prints its errors', async () => {
  const reason = 'The brief has no acceptance criteria.';
  await withTempRepo(async (repo) => {
    agentRepo(repo, [{ outcome: 'blocked', reason }]);
    const { code, stdout, stderr } = await runCaptured(SPEC_ARGV, repo.dir);
    expect({ code, stderr }).toEqual({ code: EXIT_FAILED, stderr: '' });
    const [first = '', ...rest] = stdout.split('\n');
    expect(first).toMatch(new RegExp(`^spec#1 blocked {2}${SPEC_RUN}$`));
    expect(rest.join('\n')).toContain(reason);
    expect(readResult(callDirOf(stdout, repo.dir))).toMatchObject({ outcome: 'blocked', output: null, reason });
  });
  await withTempRepo(async (repo) => {
    agentRepo(repo, [{ outcome: 'error', message: 'model overloaded' }]);
    const { code, stdout, stderr } = await runCaptured(SPEC_ARGV, repo.dir);
    expect({ code, stderr }).toEqual({ code: EXIT_FAILED, stderr: '' });
    const [first = '', ...rest] = stdout.split('\n');
    expect(first).toMatch(new RegExp(`^spec#1 error {2}${SPEC_RUN}$`));
    expect(rest).toEqual(['  harness  model overloaded', '']);
  });
}, 30_000);

type Change = (sail: string) => void;

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  .each<[string, Change, string]>([
  ['a budget of no turns', (sail) => edit(sail, `${SPEC_STAGE}/stage.ts`, 'maxTurns: 4', 'maxTurns: 0'), 'maxTurns'],
  [
    'a model alias project.yaml does not define',
    (sail) => edit(sail, `${SPEC_STAGE}/stage.ts`, "model: 'deep'", "model: 'huge'"),
    "'huge'",
  ],
  [
    'a harness whose credential is not set',
    (sail) => edit(sail, 'project.yaml', 'harness: { use: fake }', 'harness: { use: ./adapters/echo-harness.ts }'),
    'ECHO_HARNESS_TOKEN',
  ],
])('an agent stage with %s is refused with exit 3, naming it, and leaves no run directory', async (_, change, named) => {
  await withTempRepo(async (repo) => {
    change(agentRepo(repo, [submits(SPEC, 0.25)]));
    const { code, stdout, stderr } = await runCaptured(SPEC_ARGV, repo.dir, { env: {} });
    expect({ code, stdout }).toEqual({ code: EXIT_REFUSED, stdout: '' });
    expect(stderr).toContain(named);
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
}, 20_000);

const NEEDY_TICKETS = `// A ticket source that needs a credential: a run can't start without it, and an isolated stage never asks.
export default {
  requires: () => ['TICKETS_TOKEN'],
  create: () => {
    throw new Error('an isolated stage creates no ticket source');
  },
};
`;

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('an isolated agent stage needs its harness and nothing else: a ticket source without its credential does not refuse it, and it runs on a harness of the repository', async () => {
  await withTempRepo(async (repo) => {
    const sail = agentRepo(repo, [submits(SPEC, 0.25)]);
    write(sail, 'adapters/needy-tickets.ts', NEEDY_TICKETS);
    edit(sail, 'project.yaml', 'ticketSource: { use: fake, seed: ./fake/tickets.json }', 'ticketSource: { use: ./adapters/needy-tickets.ts }');
    const { code, stdout, stderr } = await runCaptured(SPEC_ARGV, repo.dir, { env: {} });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(stdout).toMatch(new RegExp(`^spec#1 done {2}${SPEC_RUN}\n$`));
  });
  await withTempRepo(async (repo) => {
    const sail = agentRepo(repo, [submits(SPEC, 0.25)]);
    edit(sail, 'project.yaml', 'harness: { use: fake }', 'harness: { use: ./adapters/echo-harness.ts }');
    // A script stage takes no harness, so it runs whatever the harness needs.
    const script = await runCaptured(['stage', 'run', '.sail/stages/tests'], repo.dir, { env: {} });
    expect({ code: script.code, stderr: script.stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    // The echo harness submits its prompt, which is no spec: twice, so the stage ends in error on its second try.
    const env = { ECHO_HARNESS_TOKEN: 'set' };
    const { code, stdout, stderr } = await runCaptured(SPEC_ARGV, repo.dir, { env });
    expect({ code, stderr }).toEqual({ code: EXIT_FAILED, stderr: '' });
    expect(stdout.split('\n')[0]).toMatch(new RegExp(`^spec#1 error {2}${SPEC_RUN}\\/try-2$`));
    const result = readResult(callDirOf(stdout, repo.dir));
    expect(result).toMatchObject({ outcome: 'error', try: 2, harness: { adapter: 'echo', sessionId: 'echo-1' } });
  });
}, 40_000);
