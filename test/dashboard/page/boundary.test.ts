// The bundle's import boundary (D13): the page's modules import at runtime only each other. From outside
// `src/dashboard/page/` they import types alone, which Bun's transpiler drops, so the browser bundle can never pull in
// `node:fs`, zod or the engine. The scan is shown to see a runtime import first, so a scan that sees nothing can't pass.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const PAGE = join(import.meta.dir, '..', '..', '..', 'src', 'dashboard', 'page');
const transpiler = new Bun.Transpiler({ loader: 'ts' });

/** The specifiers `source` imports at runtime: type-only imports are dropped. */
const runtimeImports = (source: string) => transpiler.scanImports(source).map((entry) => entry.path);

test('page modules import at runtime only each other, and the scan sees a runtime import from outside', () => {
  expect(
    runtimeImports("import { readFileSync } from 'node:fs';\nimport type { Summary } from '../../events/summary';"),
  ).toEqual(['node:fs']);
  const modules = [...new Bun.Glob('*.ts').scanSync({ cwd: PAGE })].sort();
  expect(modules).toEqual(expect.arrayContaining(['commands.ts', 'format.ts', 'html.ts']));
  const outside = modules.flatMap((module) =>
    runtimeImports(readFileSync(join(PAGE, module), 'utf8'))
      .filter((path) => !path.startsWith('./') || relative(PAGE, dirname(resolve(PAGE, path))) !== '')
      .map((path) => `${module} imports ${path}`),
  );
  expect(outside).toEqual([]);
});
