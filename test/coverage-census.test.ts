import { expect, test } from 'bun:test';
import { join } from 'node:path';

// `bun test --coverage` only reports modules some test imports, so an untested file could never fail the
// per-file gate. Importing every src module here puts each one in the report.
const root = join(import.meta.dir, '..');
const modules = [...new Bun.Glob('src/**/*.ts').scanSync({ cwd: root })]
  .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.d.ts'))
  .sort();

test('the census finds every src module', () => {
  for (const name of ['sdk', 'engine', 'ports', 'adapters', 'kinds', 'events', 'watch', 'dashboard', 'cli']) {
    expect(modules).toContain(`src/${name}/index.ts`);
  }
});

test.each(modules)('%s imports', async (path) => {
  expect(await import(join(root, path))).toBeDefined();
});
