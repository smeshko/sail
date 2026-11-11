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

/** The last segments of the paths the page POSTs to. */
const POST_SEGMENTS = [
  '/resume',
  '/restart',
  '/stop',
  '/clean',
  '/watch',
  '/unwatch',
  '/move',
  '/poll',
  '/add',
  '/requeue',
  '/drop',
  '/starts',
  '/starts/check',
];

/** The POST segments a source names as string literals. */
const namesEndpoints = (source: string) =>
  POST_SEGMENTS.filter((segment) => ["'", '"', '`'].some((quote) => source.includes(`${quote}${segment}${quote}`)));

/** Whether a source calls the host's POST. */
const posts = (source: string) => /\bhost\.post\(/.test(source);

test('no page module but the registry names a POST endpoint, and only act.ts posts', () => {
  // The scans see a planted endpoint and a planted post, so a scan that sees nothing can't pass.
  expect(namesEndpoints("const path = '/stop';")).toEqual(['/stop']);
  expect(namesEndpoints('const path = `/watch`; const other = "/drop";')).toEqual(['/watch', '/drop']);
  expect(namesEndpoints("const label = 'stop';")).toEqual([]);
  expect(posts('void store.host.post(path, body);')).toBe(true);
  expect(posts('const post = host.get(path);')).toBe(false);
  const planted = `${readFileSync(join(PAGE, 'run-view.ts'), 'utf8')}\nconst path = '/clean';`;
  expect(namesEndpoints(planted)).toEqual(['/clean']);

  const modules = [...new Bun.Glob('*.ts').scanSync({ cwd: PAGE })].sort();
  const sources = Object.fromEntries(modules.map((module) => [module, readFileSync(join(PAGE, module), 'utf8')]));
  const naming = modules.filter((module) => namesEndpoints(sources[module] ?? '').length > 0);
  expect(naming).toEqual(['action-registry.ts']);
  expect(namesEndpoints(sources['action-registry.ts'] ?? '').sort()).toEqual([...POST_SEGMENTS].sort());
  expect(modules.filter((module) => posts(sources[module] ?? ''))).toEqual(['act.ts']);
});
