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
    'the agent stage spec',
    ['.sail/workflows/ticket-to-pr/stages/spec'],
    "sail stage run: spec can't run:\n  agent steps can't run yet\n",
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
