// Reads which files a `.sail/` file references, for `sail check` and the gate-file test.
//
// The path forms it recognises are the convention a script's helpers follow, so a reference outside them is invisible:
//   .ts/.mjs/.js  `import … from './x'`, `import './x'`, `import('./x')` (tries '', .ts, .mjs, .js, /index.ts),
//                 `run: './x.sh'` (relative to the file),
//                 `join(dirname(process.env.SAIL_CONFIG), 'lib', 'x')` and `…, 'lib/x')` (under `<sailDir>/lib`)
//   .sh           `$(dirname "$0")/x` (relative to the file),
//                 `…SAIL_CONFIG…)/lib/x` and `$sail_dir/lib/x` (under `<sailDir>/lib`)
//                 where `x` may hold `/` and `..`, as in `$(dirname "$0")/../helpers/x.sh`
// A reference that resolves to no file is a problem on the referencing file, never a throw. One that resolves to a
// directory, as `cd "$(dirname "$0")/.."` does, references no file and is skipped.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DefinitionProblem } from './definitions';

export interface References {
  /** Absolute paths. */
  files: string[];
  problems: DefinitionProblem[];
}

const SOURCE_FILE = /\.(?:ts|mjs|js)$/;

function resolveImport(from: string, spec: string): string | undefined {
  const base = join(dirname(from), spec);
  return ['', '.ts', '.mjs', '.js', '/index.ts']
    .map((ext) => base + ext)
    .find((path) => SOURCE_FILE.test(path) && existsSync(path));
}

export function references(file: string, sailDir: string): References {
  const text = readFileSync(file, 'utf8');
  const files: string[] = [];
  const problems: DefinitionProblem[] = [];
  const missing = (what: string) => problems.push({ file, message: `references ${what}, which resolves to no file` });
  const add = (path: string) => {
    if (!existsSync(path)) missing(path);
    else if (statSync(path).isFile()) files.push(path);
  };
  const lib = (name: string) => add(join(sailDir, 'lib', name));
  if (SOURCE_FILE.test(file)) {
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^import\s+)['"](\.[^'"]*)['"]/gm)) {
      const found = resolveImport(file, m[1] as string);
      if (found) files.push(found);
      else missing(m[1] as string);
    }
    for (const m of text.matchAll(/\brun:\s*'(\.\/[^']+)'/g)) add(join(dirname(file), m[1] as string));
    for (const m of text.matchAll(/join\(dirname\(process\.env\.SAIL_CONFIG\),\s*'lib',\s*'([\w.-]+)'\)/g)) {
      lib(m[1] as string);
    }
    for (const m of text.matchAll(/join\(dirname\(process\.env\.SAIL_CONFIG\),\s*'lib\/([\w.-]+)'\)/g)) {
      lib(m[1] as string);
    }
  }
  if (file.endsWith('.sh')) {
    for (const m of text.matchAll(/\$\(dirname "\$0"\)\/([\w./-]+)/g)) add(join(dirname(file), m[1] as string));
    for (const m of text.matchAll(/(?:SAIL_CONFIG[^\n]*\)|\$sail_dir)\/lib\/([\w./-]+)/g)) lib(m[1] as string);
  }
  return { files, problems };
}

/** `entries` and every file they reach, absolute and in no set order. A file `stop` accepts is neither read nor kept. */
export function reachFiles(
  entries: string[],
  sailDir: string,
  stop: (file: string) => boolean = () => false,
): References {
  const seen = new Set<string>();
  const problems: DefinitionProblem[] = [];
  const queue = [...entries];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file) || stop(file)) continue;
    seen.add(file);
    const found = references(file, sailDir);
    queue.push(...found.files);
    problems.push(...found.problems);
  }
  return { files: [...seen], problems };
}
