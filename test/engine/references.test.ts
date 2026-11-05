import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { reachFiles, references } from '../../src/engine/references';

function sailDir(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'sail-refs-')), '.sail');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test('a relative import resolves with and without an extension', () => {
  const dir = sailDir({
    'a/x.ts': "import { b } from './b';\nimport c from './c.mjs';\nconst d = await import('./d');\n",
    'a/b.ts': '',
    'a/c.mjs': '',
    'a/d/index.ts': '',
  });
  const found = references(join(dir, 'a/x.ts'), dir);
  expect(found.problems).toEqual([]);
  expect(found.files.sort()).toEqual([join(dir, 'a/b.ts'), join(dir, 'a/c.mjs'), join(dir, 'a/d/index.ts')]);
});

test('a run file named by a relative path resolves', () => {
  const dir = sailDir({ 'a/stage.ts': "script({ run: './x.sh' })", 'a/x.sh': '' });
  expect(references(join(dir, 'a/stage.ts'), dir)).toEqual({ files: [join(dir, 'a/x.sh')], problems: [] });
});

test('both SAIL_CONFIG lib joins in JavaScript resolve under the given directory', () => {
  const dir = sailDir({
    'a/x.mjs':
      "join(dirname(process.env.SAIL_CONFIG), 'lib', 'one.mjs');\njoin(dirname(process.env.SAIL_CONFIG), 'lib/two.mjs');\n",
    'lib/one.mjs': '',
    'lib/two.mjs': '',
  });
  const found = references(join(dir, 'a/x.mjs'), dir);
  expect(found.problems).toEqual([]);
  expect(found.files.sort()).toEqual([join(dir, 'lib/one.mjs'), join(dir, 'lib/two.mjs')]);
});

test('the shell forms dirname $0 and lib under SAIL_CONFIG or sail_dir resolve', () => {
  const dir = sailDir({
    'a/x.sh': '"$(dirname "$0")/near.sh"\n"$(dirname "$SAIL_CONFIG")/lib/one.sh"\n"$sail_dir/lib/two.sh"\n',
    'a/near.sh': '',
    'lib/one.sh': '',
    'lib/two.sh': '',
  });
  const found = references(join(dir, 'a/x.sh'), dir);
  expect(found.problems).toEqual([]);
  expect(found.files.sort()).toEqual([join(dir, 'a/near.sh'), join(dir, 'lib/one.sh'), join(dir, 'lib/two.sh')]);
});

test('reachFiles follows references transitively and ends on a cycle', () => {
  const dir = sailDir({
    'a/x.ts': "import './y';",
    'a/y.ts': "import './x';\nimport './z';",
    'a/z.ts': '',
  });
  const found = reachFiles([join(dir, 'a/x.ts')], dir);
  expect(found.problems).toEqual([]);
  expect(found.files.sort()).toEqual([join(dir, 'a/x.ts'), join(dir, 'a/y.ts'), join(dir, 'a/z.ts')]);
});

test('a missing import is a problem on the referencing file, not a throw', () => {
  const dir = sailDir({ 'a/x.ts': "import './gone';" });
  expect(references(join(dir, 'a/x.ts'), dir)).toEqual({
    files: [],
    problems: [{ file: join(dir, 'a/x.ts'), message: 'references ./gone, which resolves to no file' }],
  });
});

test('a missing lib file is a problem on the referencing file, not a throw', () => {
  const dir = sailDir({ 'a/x.sh': '"$sail_dir/lib/gone.sh"\n' });
  const found = reachFiles([join(dir, 'a/x.sh')], dir);
  expect(found.files).toEqual([join(dir, 'a/x.sh')]);
  expect(found.problems).toEqual([
    { file: join(dir, 'a/x.sh'), message: `references ${join(dir, 'lib/gone.sh')}, which resolves to no file` },
  ]);
});

test('a shell reference into a subfolder, up a folder or to a directory resolves to files and never throws', () => {
  const dir = sailDir({
    'a/x.sh':
      '"$(dirname "$0")/helpers/near.sh"\n"$(dirname "$0")/../up.sh"\ncd "$(dirname "$0")/.."\n"$sail_dir/lib/sub/one.sh"\n',
    'a/helpers/near.sh': '',
    'up.sh': '',
    'lib/sub/one.sh': '',
  });
  const found = reachFiles([join(dir, 'a/x.sh')], dir);
  expect(found.problems).toEqual([]);
  expect(found.files.sort()).toEqual(
    [join(dir, 'a/x.sh'), join(dir, 'a/helpers/near.sh'), join(dir, 'up.sh'), join(dir, 'lib/sub/one.sh')].sort(),
  );
});
