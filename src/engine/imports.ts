// Reads who imports whom under a repository's `.sail/`, type-only imports included. Bun's transpiler drops every
// type-only form, so `tsc --explainFiles` reports the graph, resolved exactly as the type-check resolves it.
import { resolve, sep } from 'node:path';
import { isDiagnosticLine, spawnTsc } from './typecheck';

/** Who imports whom under a `.sail/`: each importing file to the files it imports, all absolute. */
export type ImportGraph = ReadonlyMap<string, readonly string[]>;

/** One reason `tsc` gives for a file: `Imported via '<specifier>' from file '<importer>'`, and maybe a packageId. */
const IMPORTED = /^\s+Imported via (['"]).*?\1 from file '(.*?)'(?: with packageId '.*')?$/;

/**
 * Parses `tsc --explainFiles` output. A line that isn't indented names the file its block explains, and each indented
 * `Imported via` reason under it is an edge from its importer. Other reasons and diagnostic lines are skipped. Relative
 * paths resolve against `cwd`. Importers come sorted, and so do each one's files, each once.
 */
export function parseExplainFiles(output: string, cwd: string): ImportGraph {
  const edges = new Map<string, Set<string>>();
  let explained: string | undefined;
  for (const text of output.split('\n')) {
    const line = text.trimEnd();
    if (line === '') continue;
    if (!/^\s/.test(line)) {
      // A diagnostic's indented lines continue it, so they explain no file.
      explained = isDiagnosticLine(line) ? undefined : resolve(cwd, line);
      continue;
    }
    const imported = IMPORTED.exec(line);
    if (explained === undefined || imported === null) continue;
    const importer = resolve(cwd, imported[2] ?? '');
    edges.set(importer, (edges.get(importer) ?? new Set()).add(explained));
  }
  const importers = [...edges.keys()].sort();
  return new Map(importers.map((importer) => [importer, [...(edges.get(importer) ?? [])].sort()]));
}

/**
 * The import graph of `dir`, a `.sail/`: only edges between two files under it, so `sail` and `zod` drop out. It runs
 * after the type-check has passed, so `tsc` failing here is internal.
 */
export async function importGraph(
  dir: string,
  options: { tsc?: string } = {},
): Promise<{ graph: ImportGraph } | { internal: string }> {
  // `tsc` fails an empty include with TS18003, and the `.sail/` that `sail init` writes has no TypeScript yet.
  if ([...new Bun.Glob('**/*.ts').scanSync({ cwd: dir })].length === 0) return { graph: new Map() };
  try {
    const { code, stdout, stderr, cwd } = await spawnTsc(dir, { ...options, args: ['--noCheck', '--explainFiles'] });
    if (code !== 0) return { internal: `tsc exited ${code}:\n${stdout}${stderr}` };
    const inside = (file: string) => file.startsWith(`${dir}${sep}`);
    const graph = new Map<string, readonly string[]>();
    for (const [importer, files] of parseExplainFiles(stdout, cwd)) {
      const kept = files.filter(inside);
      if (inside(importer) && kept.length > 0) graph.set(importer, kept);
    }
    return { graph };
  } catch (error) {
    return { internal: error instanceof Error ? error.message : String(error) };
  }
}
