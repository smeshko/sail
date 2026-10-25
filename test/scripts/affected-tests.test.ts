// scripts/affected-tests.ts selects the tests the pre-push gate runs. These cases select from a small checkout written
// into a temp repository: a src module and its importers, a spawned CLI, a helper, fixtures, a schema and an asset.
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  affectedTests,
  allTests,
  changedFiles,
  describe,
  importsOf,
  pathsNamedIn,
  type Selection,
  selectTests,
  testArgs,
} from '../../scripts/affected-tests';
import { withTempRepo } from '../helpers/temp-repo';

const TREE: Record<string, string> = {
  'src/sdk/index.ts': 'export const x = 1;\n',
  'src/engine/a.ts': 'export const a = 1;\n',
  'src/engine/b.ts': "import { a } from './a';\nexport const b = a;\n",
  'src/engine/schema.ts': "import doc from '../../schemas/doc.json' with { type: 'json' };\nexport { doc };\n",
  'src/kinds/script.ts':
    "import { join } from 'node:path';\nexport const bin = join(import.meta.dir, '..', '..', 'bin', 'sail');\n",
  'src/builtins/brief.ts': "export const brief = Bun.file(join(import.meta.dir, 'brief.md'));\n",
  'src/builtins/brief.md': '# brief\n',
  'src/cli/main.ts': "import { b } from '../engine/b';\nconsole.log(b);\n",
  'schemas/doc.json': '{}\n',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
  'bin/sail': '#!/bin/sh\nexec bun "${0%/*}/../src/cli/main.ts" "$@"\n',
  'test/engine/a.test.ts': "import { a } from '../../src/engine/a';\n",
  'test/engine/b.test.ts': "import { b } from '../../src/engine/b';\n",
  'test/engine/dynamic.test.ts': "await import('../../src/engine/a');\n",
  'test/engine/schema.test.ts': "import { doc } from '../../src/engine/schema';\n",
  'test/engine/fixtures-root.test.ts': "const FIXTURES = join(import.meta.dir, '..', 'fixtures');\n",
  'test/kinds/script.test.ts': "import { bin } from '../../src/kinds/script';\n",
  'test/builtins/brief.test.ts': "import { brief } from '../../src/builtins/brief';\n",
  'test/cli/spawn.test.ts': "const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');\n",
  'test/bin/sail.test.ts': "const BIN = join(import.meta.dir, '..', '..', 'bin', 'sail');\n",
  'test/sdk/alias.test.ts': "import { x } from 'sail';\n",
  // One-segment names reach data only: a temp `main.ts` or a `sail` binary isn't src/cli/main.ts or bin/sail.
  'test/engine/temp-main.test.ts': "writeFileSync(join(dir, 'main.ts'), '');\nconst bin = join(dir, '..', 'sail');\n",
  'test/helpers/clock.ts': 'export const now = () => 0;\n',
  'test/helpers/other.test.ts': 'export {};\n',
  'test/watch/clocked.test.ts': "import { now } from '../helpers/clock';\n",
  'test/types/case.ts': "import { x } from 'sail';\n",
  'test/types/expect.test.ts': "const cases = new Bun.Glob('*.ts');\n",
  'test/runs.test.ts': "const RUN = join(import.meta.dir, 'fixtures', 'runs', ID);\n",
  'test/fixtures/runs/r1/run.json': '{}\n',
  'test/fixtures/repo/.sail/project.yaml': 'name: fixture\n',
  'test/fixtures/repo/.sail/stage.test.ts': "import { x } from 'sail';\n",
};

function writeTree(dir: string, files: Record<string, string> = TREE): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** The tests selected when `changed` changes in a fresh copy of TREE. */
async function select(...changed: string[]): Promise<Selection> {
  return withTempRepo((repo) => {
    writeTree(repo.dir);
    return selectTests(repo.dir, changed);
  });
}

const some = (...tests: string[]): Selection => ({ kind: 'some', tests: tests.sort() });

test('importsOf resolves relative, index, JSON, dynamic and aliased imports, and leaves packages out', () => {
  const exists = (path: string) => ['src/engine/a.ts', 'src/engine/index.ts', 'schemas/doc.json'].includes(path);
  const text = [
    "import { a } from './a';",
    "import type { T } from '.';",
    "export * from '../engine/a';",
    "import doc from '../../schemas/doc.json' with { type: 'json' };",
    "const lazy = await import('./a');",
    "import { x } from 'sail';",
    "import { y } from 'sail/intakes';",
    "import { join } from 'node:path';",
    "import { z } from 'zod';",
    "import { gone } from './gone';",
  ].join('\n');
  expect(importsOf('src/engine/b.ts', text, exists)).toEqual([
    'src/engine/a.ts',
    'src/engine/index.ts',
    'src/engine/a.ts',
    'schemas/doc.json',
    'src/engine/a.ts',
    'src/sdk/index.ts',
    'src/sdk/intakes.ts',
    'src/engine/gone',
  ]);
});

test('pathsNamedIn reads a run of literals as one path, and a lone literal only when it holds a slash or a file', () => {
  const text = [
    "const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');",
    "const RUN = join(dir, 'fixtures', 'runs', ID);",
    "const repo = join(root, 'repo');",
    "Bun.spawn([process.execPath, 'test']);",
    "readFileSync(join(dir, 'brief.md'));",
    'const glob = `src/**/*.ts`;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
    'exec bun "${0%/*}/../src/cli/main.ts"',
    "const hidden = join(home, '.sail');",
    "import { a } from '../engine/a';",
  ].join('\n');
  expect(pathsNamedIn(text)).toEqual([
    ['src', 'cli', 'main.ts'],
    ['fixtures', 'runs'],
    ['brief.md'],
    ['src', 'cli', 'main.ts'],
  ]);
});

test('a changed module selects its tests and the tests of every module that imports it, transitively', async () => {
  expect(await select('src/engine/a.ts')).toEqual(
    some(
      'test/engine/a.test.ts',
      'test/engine/b.test.ts',
      'test/engine/dynamic.test.ts',
      // src/cli/main.ts imports b, test/cli/spawn.test.ts spawns main.ts, and bin/sail execs it.
      'test/cli/spawn.test.ts',
      'test/bin/sail.test.ts',
    ),
  );
});

test('a path src names reaches it only when it is data: src/kinds/script.ts naming bin/sail is not a dependency', async () => {
  expect(await select('bin/sail')).toEqual(some('test/bin/sail.test.ts'));
  expect(await select('src/builtins/brief.md')).toEqual(some('test/builtins/brief.test.ts'));
  expect(await select('schemas/doc.json')).toEqual(some('test/engine/schema.test.ts'));
});

test('a changed helper widens to the tests that import it and the tests beside it', async () => {
  expect(await select('test/helpers/clock.ts')).toEqual(
    some('test/helpers/other.test.ts', 'test/watch/clocked.test.ts'),
  );
  expect(await select('test/types/case.ts')).toEqual(some('test/types/expect.test.ts'));
});

test('a changed fixture widens to the tests that name its path, and fixture code selects nothing on its own', async () => {
  expect(await select('test/fixtures/runs/r1/run.json')).toEqual(
    some('test/engine/fixtures-root.test.ts', 'test/runs.test.ts'),
  );
  expect(await select('test/fixtures/repo/.sail/project.yaml')).toEqual(some('test/engine/fixtures-root.test.ts'));
});

test('the sail alias reaches the SDK, and a changed test selects itself', async () => {
  expect(await select('src/sdk/index.ts')).toEqual(some('test/sdk/alias.test.ts', 'test/types/expect.test.ts'));
  expect(await select('test/watch/clocked.test.ts', 'test/engine/deleted.test.ts')).toEqual(
    some('test/watch/clocked.test.ts'),
  );
});

test('prose, CI and hook changes select no test', async () => {
  expect(
    await select('CONTEXT.md', 'AGENTS.md', 'docs/adr/0001.md', '.github/workflows/verify.yml', '.githooks/pre-push'),
  ).toEqual(some());
});

test("sail's own .sail/ selects no test, while the fixture repository's .sail/ still reaches the tests naming it", async () => {
  expect(await select('.sail/project.yaml', '.sail/workflows/factory/workflow.ts', '.sail/fake/harness.json')).toEqual(
    some(),
  );
  expect(await select('test/fixtures/repo/.sail/project.yaml')).not.toEqual(some());
});

test('a toolchain change, or one no rule places, selects every test', async () => {
  for (const path of ['package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'scripts/test.ts', 'test/setup.ts']) {
    expect(await select('src/engine/a.ts', path)).toEqual({ kind: 'all', reason: `${path} changed` });
  }
  expect(await select('test/coverage-census.test.ts')).toEqual({
    kind: 'all',
    reason: 'test/coverage-census.test.ts changed',
  });
  expect(await select('Makefile')).toEqual({
    kind: 'all',
    reason: 'Makefile changed, and no rule says which tests it reaches',
  });
});

test('changedFiles lists committed, unstaged, deleted and untracked changes since the merge-base', async () => {
  await withTempRepo((repo) => {
    writeTree(repo.dir, { 'src/a.ts': 'export {};\n', 'src/b.ts': 'export {};\n', 'src/c.ts': 'export {};\n' });
    repo.git('add', '.');
    repo.git('commit', '-m', 'tree');
    repo.git('branch', 'staging');
    repo.git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo.dir, 'src/a.ts'), 'export const a = 1;\n');
    repo.git('commit', '-qam', 'a');
    repo.git('checkout', '-q', 'staging');
    writeFileSync(join(repo.dir, 'src/b.ts'), 'export const b = 1;\n');
    repo.git('commit', '-qam', 'b on staging');
    repo.git('checkout', '-q', 'feature');
    writeFileSync(join(repo.dir, 'src/c.ts'), 'export const c = 1;\n');
    repo.git('rm', '-q', 'README.md');
    writeFileSync(join(repo.dir, 'src/d.ts'), 'export {};\n');

    // src/b.ts changed on staging after the merge-base, so it isn't the branch's change.
    expect(changedFiles(repo.dir, 'staging', repo.env)).toEqual(['README.md', 'src/a.ts', 'src/c.ts', 'src/d.ts']);
    expect(changedFiles(repo.dir, 'no-such-branch', repo.env)).toBeUndefined();
  });
});

test('affectedTests selects from the branch, and every test when there is no merge-base', async () => {
  await withTempRepo((repo) => {
    writeTree(repo.dir);
    repo.git('add', '.');
    repo.git('commit', '-m', 'tree');
    repo.git('branch', 'staging');
    writeFileSync(join(repo.dir, 'test/helpers/clock.ts'), 'export const now = () => 1;\n');

    expect(affectedTests(repo.dir, 'staging', repo.env)).toEqual(
      some('test/helpers/other.test.ts', 'test/watch/clocked.test.ts'),
    );
    expect(affectedTests(repo.dir, 'origin/staging', repo.env)).toEqual({
      kind: 'all',
      reason: 'no merge-base with origin/staging',
    });
    expect(allTests(repo.dir)).toEqual(
      Object.keys(TREE)
        .filter((path) => path.endsWith('.test.ts') && !path.startsWith('test/fixtures/'))
        .sort(),
    );
  });
});

const CI = { CI: 'true' };

test('testArgs runs the selection with a generous timeout, every test only under test/ and on CI, nothing when empty', () => {
  expect(testArgs({ kind: 'all', reason: 'x' }, CI)).toEqual(['--timeout', '60000', './test']);
  expect(testArgs({ kind: 'all', reason: 'x' }, {})).toBeUndefined();
  expect(testArgs(some('test/a.test.ts', 'test/b.test.ts'), {})).toEqual([
    '--timeout',
    '60000',
    './test/a.test.ts',
    './test/b.test.ts',
  ]);
  expect(testArgs(some(), CI)).toBeUndefined();
});

test('describe says why every test runs or is left to CI, how many were selected, or that the step is skipped', () => {
  expect(describe({ kind: 'all', reason: 'bun.lock changed' }, CI)).toBe(
    'affected tests: every test, because bun.lock changed',
  );
  expect(describe({ kind: 'all', reason: 'bun.lock changed' }, {})).toBe(
    "affected tests: every test, because bun.lock changed. CI's verify runs them, so the test step is skipped here " +
      '(SAIL_FULL_SUITE=1 runs them)',
  );
  expect(describe(some('test/a.test.ts'), {})).toBe('affected tests: 1 file');
  expect(describe(some('test/a.test.ts', 'test/b.test.ts'), {})).toBe('affected tests: 2 files');
  expect(describe(some(), {})).toBe('affected tests: none, so the test step is skipped');
});
