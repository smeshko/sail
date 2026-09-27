import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type ImportGraph, importGraph, parseExplainFiles } from '../../src/engine/imports';
import { withTempRepo } from '../helpers/temp-repo';

const fixture = join(import.meta.dir, '..', 'fixtures', 'repo', '.sail');

/** The graph with every path relative to `dir`, as a plain object. */
function relativeTo(dir: string, graph: ImportGraph): Record<string, string[]> {
  return Object.fromEntries(
    [...graph].map(([importer, imported]) => [relative(dir, importer), imported.map((file) => relative(dir, file))]),
  );
}

/** A `tsc` stand-in that prints `boom` and exits 2. */
function failingTsc(dir: string): string {
  const tsc = join(dir, 'tsc.js');
  writeFileSync(tsc, "console.log('boom');\nprocess.exit(2);\n");
  return tsc;
}

test('parseExplainFiles reads each import edge, in either quote style, and skips everything else', () => {
  const output = [
    ".sail/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "   Imported via './x' from file '.sail/continuation.ts'",
    "error TS5102: Option 'x' has been removed.",
    '../lib/lib.es5.d.ts',
    "   Library referenced via 'es5' from file '../lib/lib.es2015.d.ts'",
    '.sail/b.ts',
    "   Imported via './b' from file '.sail/main.ts'",
    `   Imported via "./b" from file '.sail/other.ts' with packageId 'b/index.d.ts@1.0.0'`,
    "   Matched by include pattern '/repo/.sail/**/*.ts' in '/tmp/tsconfig.json'",
    '.sail/main.ts',
    "   Part of 'files' list in tsconfig.json",
    '.sail/c.ts',
    "   Imported via './c' from file '.sail/main.ts'",
    "   Imported via './c.ts' from file '.sail/main.ts'",
    '',
  ].join('\n');
  expect(relativeTo('/repo', parseExplainFiles(output, '/repo'))).toEqual({
    '.sail/main.ts': ['.sail/b.ts', '.sail/c.ts'],
    '.sail/other.ts': ['.sail/b.ts'],
  });
});

test("the fixture's graph holds exactly the imports its files make within .sail/", async () => {
  await withTempRepo(async (repo) => {
    const sail = join(repo.dir, '.sail');
    cpSync(fixture, sail, { recursive: true });
    const result = await importGraph(sail);
    if ('internal' in result) throw new Error(result.internal);
    const graph = relativeTo(sail, result.graph);
    console.log(`the fixture's import graph: ${JSON.stringify(graph, null, 2)}`);
    expect(graph).toEqual({
      'stages/implement/stage.ts': ['stages/tests/stage.ts'],
      'workflows/ticket-to-pr/stages/self-review/stage.ts': ['stages/implement/stage.ts'],
      'workflows/ticket-to-pr/workflow.ts': [
        'stages/implement/stage.ts',
        'stages/tests/stage.ts',
        'workflows/ticket-to-pr/stages/publish/stage.ts',
        'workflows/ticket-to-pr/stages/self-review/stage.ts',
        'workflows/ticket-to-pr/stages/spec/stage.ts',
      ],
    });
  });
});

test('every type-only import is an edge, and a commented-out one is not', async () => {
  await withTempRepo(async (repo) => {
    const sail = join(repo.dir, '.sail');
    mkdirSync(sail);
    for (const name of ['B', 'C', 'G', 'J']) {
      writeFileSync(join(sail, `${name.toLowerCase()}.ts`), `export type ${name} = string;\n`);
    }
    writeFileSync(join(sail, 'k.ts'), 'export const K = 1;\n');
    writeFileSync(
      join(sail, 'main.ts'),
      [
        "import type { B } from './b';",
        "import { type C } from './c';",
        "export type { G } from './g';",
        "// import { K } from './k';",
        "export type J = import('./j').J;",
        'export type BC = B | C;',
        '',
      ].join('\n'),
    );
    const result = await importGraph(sail);
    if ('internal' in result) throw new Error(result.internal);
    expect(relativeTo(sail, result.graph)).toEqual({ 'main.ts': ['b.ts', 'c.ts', 'g.ts', 'j.ts'] });
  });
});

test('a tsc that exits non-zero is internal, with its output', async () => {
  await withTempRepo(async (repo) => {
    const sail = join(repo.dir, '.sail');
    cpSync(fixture, sail, { recursive: true });
    expect(await importGraph(sail, { tsc: failingTsc(repo.dir) })).toEqual({ internal: 'tsc exited 2:\nboom\n' });
  });
});

test('a .sail/ with no TypeScript is an empty graph, without running tsc', async () => {
  await withTempRepo(async (repo) => {
    const sail = join(repo.dir, '.sail');
    mkdirSync(sail);
    expect(await importGraph(sail, { tsc: failingTsc(repo.dir) })).toEqual({ graph: new Map() });
  });
});
