// `sail init`, in process through run(): the `.sail/` it writes in the directory it is run from, the three lines it adds
// to `.gitignore`, and what it refuses. Each case has a temporary repository of its own, whose directory is named
// `repo` and whose HOME is elsewhere.
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { labelOf, rangeOf, slugOf } from '../../src/cli/commands/init';
import { EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { readConfig } from '../../src/engine/config';
import { editorDeclarations } from '../../src/engine/editor';
import { CHECK_OPTIONS } from '../../src/engine/typecheck';
import { write } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `sail init`, then `args`, from `cwd`, in the repository's environment. */
const init = (repo: TempRepo, cwd = repo.dir, args: string[] = []) =>
  runCaptured(['init', ...args], cwd, { env: repo.env });

/** The names in `dir`, sorted, or null when nothing is there. */
const listing = (dir: string): string[] | null => (existsSync(dir) ? readdirSync(dir).sort() : null);
/** What `path` holds, or null when nothing is there. */
const textOf = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);

const FILES = ['project.yaml', 'sail-intakes.d.ts', 'sail.d.ts', 'tsconfig.json'];
const WROTE = `wrote .sail/project.yaml
wrote .sail/tsconfig.json
wrote .sail/sail.d.ts
wrote .sail/sail-intakes.d.ts
`;
const NEXT =
  'next: set name and label in .sail/project.yaml, write a workflow under .sail/workflows/, then run sail check\n';
const IGNORED = '.sail-runs/\n.sail/sail.d.ts\n.sail/sail-intakes.d.ts\n';
const FAKE = { use: 'fake' };

test('in a git repository, sail init exits 0, writes exactly the config, the tsconfig.json and the two editor declarations into .sail/, and prints each file it wrote and the next steps', async () => {
  await withTempRepo(async (repo) => {
    const { code, stdout, stderr } = await init(repo);
    expect(listing(join(repo.dir, '.sail'))).toEqual(FILES);
    expect({ code, stdout, stderr }).toEqual({
      code: EXIT_OK,
      stdout: `${WROTE}wrote .gitignore\n${NEXT}`,
      stderr: '',
    });
    expect(listing(repo.dir)).toEqual(['.git', '.gitignore', '.sail', 'README.md']);
    for (const { name, text } of editorDeclarations()) expect(textOf(join(repo.dir, '.sail', name))).toBe(text);
  });
});

test("project.yaml validates against sail.project.v1: the directory's name, the label sail-<name>, this version's range and all four ports on fake, with no defaultWorkflow and the real adapters named in comments", async () => {
  await withTempRepo(async (repo) => {
    await init(repo);
    const text = textOf(join(repo.dir, '.sail', 'project.yaml')) ?? '';
    expect(text).not.toBe('');
    expect<unknown>(readConfig(join(repo.dir, '.sail'))).toEqual({
      name: 'repo',
      sail: `>=${pkg.version} <${Number(pkg.version.split('.')[0]) + 1}`,
      label: 'sail-repo',
      adapters: { ticketSource: FAKE, codeHost: FAKE, harness: FAKE, workspace: FAKE },
      models: {},
      budgets: {},
    });
    const comments = text
      .split('\n')
      .flatMap((line) => (line.includes('#') ? [line.slice(line.indexOf('#'))] : []))
      .join('\n');
    for (const adapter of ['linear', 'github', 'claude-code', 'git-worktree']) expect(comments).toContain(adapter);
    expect(text).toMatch(/^# defaultWorkflow: /m);
    expect(text).not.toContain('{{');
  });
});

test('sail check on what sail init wrote passes with 0 workflows and 0 stages, and sail FAKE-1 there is refused for want of a workflow, with no .sail-runs/', async () => {
  await withTempRepo(async (repo) => {
    await init(repo);
    expect(await runCaptured(['check'], repo.dir, { env: repo.env })).toEqual({
      code: EXIT_OK,
      stdout: '.sail/ checked: 0 workflows, 0 stages\n',
      stderr: '',
    });
    expect(await runCaptured(['FAKE-1'], repo.dir, { env: repo.env })).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: 'sail FAKE-1: no --workflow given, and .sail/project.yaml sets no defaultWorkflow\n',
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
    expect(listing(join(repo.dir, '.sail'))).toEqual(FILES);
  });
});

test("tsconfig.json holds sail's house rules, CHECK_OPTIONS, with paths from sail and sail/intakes to the two editor declarations, and includes every .ts under .sail/", async () => {
  await withTempRepo(async (repo) => {
    await init(repo);
    const config = JSON.parse(textOf(join(repo.dir, '.sail', 'tsconfig.json')) ?? '{}');
    expect(config).toEqual({
      compilerOptions: {
        ...CHECK_OPTIONS,
        paths: { sail: ['./sail.d.ts'], 'sail/intakes': ['./sail-intakes.d.ts'] },
      },
      include: ['**/*.ts'],
    });
  });
});

const HELLO = (type: string) => `// hello: one script stage, written in the workflow's own file.
import { script, workflow, z } from 'sail';
import { ticket } from 'sail/intakes';

const hello = script('hello', { run: './run.sh', output: z.object({ ok: z.boolean() }) });

export default workflow('hello', { intake: ticket, version: 1 }, async (run) => {
  const said = await run.stage(hello);
  const ok: ${type} = said.output.ok;
  return ok;
});
`;

/** Runs the `tsc` sail check runs, as an editor would: on the repository's own `.sail/tsconfig.json`. */
function editorTsc(repo: TempRepo) {
  const tsc = join(dirname(Bun.resolveSync('typescript/package.json', import.meta.dir)), 'bin', 'tsc');
  const argv = [process.execPath, tsc, '--pretty', 'false', '-p', join(repo.dir, '.sail', 'tsconfig.json')];
  const child = Bun.spawnSync(argv, { cwd: repo.dir, env: repo.env, stdout: 'pipe', stderr: 'pipe' });
  return {
    code: child.exitCode,
    lines: child.stdout
      .toString()
      .split('\n')
      .filter((line) => line !== ''),
  };
}

test("an editor's tsc on what sail init wrote resolves sail and sail/intakes: a workflow with one planted type error gets that error and no other, and one with none passes", async () => {
  await withTempRepo(async (repo) => {
    await init(repo);
    const sail = join(repo.dir, '.sail');
    expect(listing(sail)).toEqual(FILES);
    write(sail, 'workflows/hello/workflow.ts', HELLO('string'));
    const planted = editorTsc(repo);
    expect(planted.lines).toEqual([
      ".sail/workflows/hello/workflow.ts(9,9): error TS2322: Type 'boolean' is not assignable to type 'string'.",
    ]);
    expect(planted.code).not.toBe(0);
    write(sail, 'workflows/hello/workflow.ts', HELLO('boolean'));
    expect(editorTsc(repo)).toEqual({ code: 0, lines: [] });
  });
}, 60_000);

test.each<[string, string | null, string, string]>([
  ['a missing .gitignore is created with the three lines', null, IGNORED, 'wrote .gitignore\n'],
  [
    'an existing one gains the lines it lacks, after a newline when its last line has none',
    'node_modules/\n.sail-runs/',
    'node_modules/\n.sail-runs/\n.sail/sail.d.ts\n.sail/sail-intakes.d.ts\n',
    'updated .gitignore\n',
  ],
  ['an empty one gains all three, with no blank line first', '', IGNORED, 'updated .gitignore\n'],
  [
    'one that holds all three, in any order, is left byte for byte, and nothing is said of it',
    '.sail/sail-intakes.d.ts\n# sail\n.sail-runs/\n\n.sail/sail.d.ts',
    '.sail/sail-intakes.d.ts\n# sail\n.sail-runs/\n\n.sail/sail.d.ts',
    '',
  ],
])('.gitignore: %s', async (_, before, after, said) => {
  await withTempRepo(async (repo) => {
    if (before !== null) writeFileSync(join(repo.dir, '.gitignore'), before);
    const { code, stdout } = await init(repo);
    expect(textOf(join(repo.dir, '.gitignore'))).toBe(after);
    expect([code, stdout]).toEqual([EXIT_OK, `${WROTE}${said}${NEXT}`]);
  });
});

test('after sail init, git ignores the two editor declarations and the runs, and lists neither declaration as untracked', async () => {
  await withTempRepo(async (repo) => {
    await init(repo);
    expect(listing(join(repo.dir, '.sail'))).toEqual(FILES);
    const ignored = repo.git('check-ignore', '.sail/sail.d.ts', '.sail/sail-intakes.d.ts', '.sail-runs/x');
    expect(ignored.split('\n')).toEqual(['.sail/sail.d.ts', '.sail/sail-intakes.d.ts', '.sail-runs/x']);
    expect(repo.git('status', '--porcelain', '--untracked-files=all').split('\n').sort()).toEqual([
      '?? .gitignore',
      '?? .sail/project.yaml',
      '?? .sail/tsconfig.json',
    ]);
  });
});

test.each([
  ['My App', 'my-app'],
  ['API_v2', 'api-v2'],
  ['--x--', 'x'],
  ['___', 'repository'],
  ['', 'repository'],
  ['repo', 'repo'],
  ['Ünïcode.Näme', 'n-code-n-me'],
  ['123', '123'],
])("a directory named '%s' gives the name %s, and the label sail-<name>", (directory, name) => {
  expect([slugOf(directory), labelOf(slugOf(directory))]).toEqual([name, `sail-${name}`]);
});

test("the range is this version up to its next major: '>=0.0.0 <1' today", () => {
  expect([rangeOf('0.0.0'), rangeOf('0.4.2'), rangeOf('1.4.2'), rangeOf('12.0.0')]).toEqual([
    '>=0.0.0 <1',
    '>=0.4.2 <1',
    '>=1.4.2 <2',
    '>=12.0.0 <13',
  ]);
  expect(rangeOf(pkg.version)).toBe('>=0.0.0 <1');
});

test.each([
  ['My App', 'my-app'],
  ['123', '123'],
])(
  "run in the folder '%s' below the git root, it writes .sail/ and .gitignore in that folder, named %s",
  async (folder, name) => {
    await withTempRepo(async (repo) => {
      const cwd = join(repo.dir, 'packages', folder);
      mkdirSync(cwd, { recursive: true });
      const { code } = await init(repo, cwd);
      expect([listing(cwd), listing(repo.dir)]).toEqual([
        ['.gitignore', '.sail'],
        ['.git', 'README.md', 'packages'],
      ]);
      expect(code).toBe(EXIT_OK);
      expect(readConfig(join(cwd, '.sail'))).toMatchObject({ name, label: `sail-${name}` });
      expect(textOf(join(cwd, '.gitignore'))).toBe(IGNORED);
      // A `.sail/` of the folder's own: sail check finds it from there.
      expect((await runCaptured(['check'], cwd, { env: repo.env })).stdout).toBe(
        '.sail/ checked: 0 workflows, 0 stages\n',
      );
    });
  },
);

test('outside a git repository it exits 3, naming the directory, and writes nothing', async () => {
  await withTempRepo(async (repo) => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sail-init-')));
    dirs.push(outside);
    expect(await init(repo, outside)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: `sail init: not inside a git repository: ${outside}\n`,
    });
    expect(listing(outside)).toEqual([]);
  });
});

test("in the home directory, as HOME names it or links to it, it exits 3: that .sail/ is sail's own", async () => {
  await withTempRepo(async (repo) => {
    const linked = join(repo.home, 'link-to-repo');
    symlinkSync(repo.dir, linked);
    for (const home of [repo.dir, linked]) {
      expect(await runCaptured(['init'], repo.dir, { env: { ...repo.env, HOME: home } })).toEqual({
        code: EXIT_REFUSED,
        stdout: '',
        stderr: `sail init: ${repo.dir} is the home directory, whose .sail/ is sail's own\n`,
      });
    }
    expect(listing(repo.dir)).toEqual(['.git', 'README.md']);
  });
});

test.each<[string, (path: string) => void]>([
  ['a directory', (path) => mkdirSync(path)],
  ['a file', (path) => writeFileSync(path, '')],
  ['a link to nothing', (path) => symlinkSync(join(path, '..', 'nowhere'), path)],
])('where .sail exists as %s it exits 3, and never overwrites it', async (_, make) => {
  await withTempRepo(async (repo) => {
    make(join(repo.dir, '.sail'));
    expect(await init(repo)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: 'sail init: .sail/ already exists here, and sail init never overwrites one\n',
    });
    expect(listing(repo.dir)).toEqual(['.git', '.sail', 'README.md']);
    const sail = join(repo.dir, '.sail');
    expect(fs.lstatSync(sail).isDirectory() ? readdirSync(sail) : []).toEqual([]);
  });
});

test.skipIf(process.getuid?.() === 0)(
  "in a directory it can't write to it exits 3 with why, and leaves the directory as it was",
  async () => {
    await withTempRepo(async (repo) => {
      const cwd = join(repo.dir, 'locked');
      mkdirSync(cwd);
      chmodSync(cwd, 0o555);
      try {
        const { code, stdout, stderr } = await init(repo, cwd);
        expect({ code, stdout }).toEqual({ code: EXIT_REFUSED, stdout: '' });
        expect(stderr).toStartWith('sail init: could not write .sail/: EACCES');
        expect(listing(cwd)).toEqual([]);
      } finally {
        chmodSync(cwd, 0o755);
      }
    });
  },
);

test('when the last write fails, the rename into place, no .sail/ is left, and nothing of the one being built', async () => {
  await withTempRepo(async (repo) => {
    const rename = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EIO: i/o error, rename');
    });
    try {
      expect(await init(repo)).toEqual({
        code: EXIT_REFUSED,
        stdout: '',
        stderr: 'sail init: could not write .sail/: EIO: i/o error, rename\n',
      });
      expect(rename).toHaveBeenCalledTimes(1);
    } finally {
      rename.mockRestore();
    }
    expect(listing(repo.dir)).toEqual(['.git', 'README.md']);
  });
});

test("a .gitignore that can't be read is refused before anything is written", async () => {
  await withTempRepo(async (repo) => {
    mkdirSync(join(repo.dir, '.gitignore'));
    const { code, stdout, stderr } = await init(repo);
    expect({ code, stdout }).toEqual({ code: EXIT_REFUSED, stdout: '' });
    expect(stderr).toStartWith('sail init: could not read .gitignore: EISDIR');
    expect(listing(repo.dir)).toEqual(['.git', '.gitignore', 'README.md']);
  });
});

test.skipIf(process.getuid?.() === 0)(
  "a .gitignore that can't be written fails after .sail/ is in place, and the message says so",
  async () => {
    await withTempRepo(async (repo) => {
      const gitignore = join(repo.dir, '.gitignore');
      writeFileSync(gitignore, 'node_modules/\n');
      chmodSync(gitignore, 0o444);
      const { code, stdout, stderr } = await init(repo);
      expect(stderr).toStartWith('sail init: .sail/ is written, but .gitignore could not be: EACCES');
      expect({ code, stdout }).toEqual({ code: EXIT_REFUSED, stdout: WROTE });
      expect([listing(join(repo.dir, '.sail')), textOf(gitignore)]).toEqual([FILES, 'node_modules/\n']);
    });
  },
);

test.each([['extra'], ['--force']])(
  'sail init %s exits 3 as an unknown argument, and writes nothing',
  async (argument) => {
    await withTempRepo(async (repo) => {
      expect(await init(repo, repo.dir, [argument])).toEqual({
        code: EXIT_REFUSED,
        stdout: '',
        stderr: `sail: unknown argument '${argument}'\nRun 'sail --help' for usage.\n`,
      });
      expect(listing(repo.dir)).toEqual(['.git', 'README.md']);
    });
  },
);

test('a .gitignore whose write fails half way keeps what it held: the lines are written beside it and renamed over it, and nothing is left beside it', async () => {
  await withTempRepo(async (repo) => {
    const gitignore = join(repo.dir, '.gitignore');
    writeFileSync(gitignore, 'node_modules/\n');
    chmodSync(gitignore, 0o640);
    const real = fs.writeFileSync;
    // A full disk: the file being written is cut to nothing, and the write throws.
    const full = spyOn(fs, 'writeFileSync').mockImplementation((path, data, options) => {
      if (!String(path).includes('.gitignore')) return real(path, data, options);
      real(path, '');
      throw new Error('ENOSPC: no space left on device, write');
    });
    try {
      const { code, stdout, stderr } = await init(repo);
      expect(stderr).toBe(
        'sail init: .sail/ is written, but .gitignore could not be: ENOSPC: no space left on device, write\n',
      );
      expect({ code, stdout }).toEqual({ code: EXIT_REFUSED, stdout: WROTE });
    } finally {
      full.mockRestore();
    }
    expect(textOf(gitignore)).toBe('node_modules/\n');
    expect(listing(repo.dir)).toEqual(['.git', '.gitignore', '.sail', 'README.md']);
  });
});

test('an existing .gitignore keeps its mode when it gains the lines, and one that is a link stays a link to the file that gained them', async () => {
  await withTempRepo(async (repo) => {
    const shared = join(repo.dir, 'shared.gitignore');
    writeFileSync(shared, 'node_modules/\n');
    chmodSync(shared, 0o640);
    symlinkSync('shared.gitignore', join(repo.dir, '.gitignore'));
    expect((await init(repo)).code).toBe(EXIT_OK);
    expect(fs.lstatSync(join(repo.dir, '.gitignore')).isSymbolicLink()).toBe(true);
    expect(textOf(shared)).toBe(`node_modules/\n${IGNORED}`);
    expect(fs.statSync(shared).mode & 0o777).toBe(0o640);
    expect(listing(repo.dir)).toEqual(['.git', '.gitignore', '.sail', 'README.md', 'shared.gitignore']);
  });
});
