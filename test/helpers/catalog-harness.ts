// A copy of the fixture repository with a named harness, `cat`, whose checkModels() refuses every model id that ends
// in -typo: what `sail check` and `sail watch` ask before any run reaches a model.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE_SAIL = join(import.meta.dir, '..', 'fixtures', 'repo', '.sail');

const CATALOG_HARNESS = `export default {
  checkModels: async (_options: object, _env: object, models: readonly string[]) =>
    models.filter((model) => model.endsWith('-typo')).map((model) => ({ model, problem: \`no model \${model}\` })),
  create: () => ({ name: 'catalog' }),
};
`;

/** Copies the fixture's .sail/ into `repoDir` with `cat` among its harnesses and `models` as its aliases. */
export function withCatalog(repoDir: string, models: string): string {
  const sail = join(repoDir, '.sail');
  cpSync(FIXTURE_SAIL, sail, { recursive: true });
  addCatalog(sail);
  setModels(sail, models);
  return sail;
}

/** Writes the catalog harness into `sail`'s adapters/, and names it `cat` among project.yaml's harnesses. */
export function addCatalog(sail: string): void {
  mkdirSync(join(sail, 'adapters'), { recursive: true });
  writeFileSync(join(sail, 'adapters', 'catalog-harness.ts'), CATALOG_HARNESS);
  const yaml = join(sail, 'project.yaml');
  const text = readFileSync(yaml, 'utf8').replace(
    '  workspace: { use: fake }\n',
    '  workspace: { use: fake }\n  harnesses: { cat: { use: ./adapters/catalog-harness.ts } }\n',
  );
  writeFileSync(yaml, text);
}

/** Puts `models` in place of the aliases of `sail`'s project.yaml. */
export function setModels(sail: string, models: string): void {
  const yaml = join(sail, 'project.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^models: .*$/m, `models: ${models}`));
}
