// Type-checks a repository's `.sail/` against the SDK's committed declarations, the way `sail check` refuses a wrongly
// wired workflow. TypeScript 7 has no stable compiler API, so `tsc` runs as a subprocess and its output is parsed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');

/**
 * sail's house rules, the options sail holds its own code to. The check never extends a repository's
 * `.sail/tsconfig.json`, so a repository can't loosen them. `allowImportingTsExtensions` only lets `./x.ts`
 * specifiers resolve, as Bun does, and `types: []` keeps runtime globals out of workflow code.
 */
export const CHECK_OPTIONS = {
  target: 'ESNext',
  lib: ['ESNext'],
  module: 'preserve',
  moduleResolution: 'bundler',
  types: [],
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
} as const;

/**
 * `sail` and `sail/intakes` map to the committed `.d.ts` in `types/`, not to `src/sdk`: a source target would be
 * checked under the repository's options instead of sail's. The `.d.ts` stays inside sail's package tree, so its
 * `import … from 'zod'` resolves from sail's `node_modules` and the repository needs none.
 */
export const SDK_TYPES = {
  sail: [join(PACKAGE_ROOT, 'types', 'index.d.ts')],
  'sail/intakes': [join(PACKAGE_ROOT, 'types', 'intakes.d.ts')],
};

/** One thing `tsc` reported. `file` is absolute, and a global diagnostic has no location. */
export interface Diagnostic {
  file?: string;
  line?: number;
  column?: number;
  /** `TSnnnn`, or empty for a line `tsc` printed that isn't a diagnostic. */
  code: string;
  message: string;
}

export type TypecheckResult =
  | { ok: true; files: number }
  | { ok: false; diagnostics: Diagnostic[] }
  | { internal: string };

const LOCATED = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const GLOBAL = /^error (TS\d+): (.*)$/;

/**
 * Parses `tsc --pretty false` output. An indented line continues the diagnostic before it, and any other line becomes a
 * diagnostic with no code, so nothing `tsc` prints is dropped. Relative files resolve against `cwd`.
 */
export function parseDiagnostics(output: string, cwd: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const text of output.split('\n')) {
    const line = text.trimEnd();
    if (line === '') continue;
    const previous = diagnostics.at(-1);
    if (/^\s/.test(line) && previous !== undefined) {
      previous.message += `\n${line}`;
      continue;
    }
    const located = LOCATED.exec(line);
    if (located !== null) {
      const [, file = '', row = '', column = '', code = '', message = ''] = located;
      diagnostics.push({ file: resolve(cwd, file), line: Number(row), column: Number(column), code, message });
      continue;
    }
    const global = GLOBAL.exec(line);
    diagnostics.push(
      global === null ? { code: '', message: line.trim() } : { code: global[1] ?? '', message: global[2] ?? '' },
    );
  }
  return diagnostics;
}

/**
 * Checks every `**\/*.ts` under `dir`, a `.sail/`, under the house rules, or only `options.files` and what they import.
 * `tsc` runs from the repository, the parent of `dir`, and every file it reports comes back absolute.
 */
export async function typecheck(
  dir: string,
  options: { tsc?: string; files?: string[] } = {},
): Promise<TypecheckResult> {
  // `tsc` fails an empty include with TS18003, and the `.sail/` that `sail init` writes has no TypeScript yet.
  const files = options.files?.length ?? [...new Bun.Glob('**/*.ts').scanSync({ cwd: dir })].length;
  if (files === 0) return { ok: true, files };

  const configDir = mkdtempSync(join(tmpdir(), 'sail-check-'));
  try {
    const config = join(configDir, 'tsconfig.json');
    // The include is absolute because `tsc` skips dot-directories under a pattern, unless the literal base path holds
    // them.
    const compilerOptions = { ...CHECK_OPTIONS, paths: SDK_TYPES };
    const roots = options.files === undefined ? { include: [join(dir, '**', '*.ts')] } : { files: options.files };
    writeFileSync(config, JSON.stringify({ compilerOptions, ...roots }));

    const tsc = options.tsc ?? join(dirname(Bun.resolveSync('typescript/package.json', import.meta.dir)), 'bin', 'tsc');
    const cwd = dirname(dir);
    const child = Bun.spawn([process.execPath, tsc, '--noEmit', '--pretty', 'false', '-p', config], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code === 0) return { ok: true, files };
    // `tsc` exits 1 on type errors and 2 on a config error. Either way, a diagnostic with a code is the repository's
    // problem; anything else means `tsc` itself didn't run properly.
    const diagnostics = parseDiagnostics(stdout, cwd);
    if (diagnostics.some((diagnostic) => diagnostic.code !== '')) return { ok: false, diagnostics };
    return { internal: `tsc exited ${code}:\n${stdout}${stderr}` };
  } catch (error) {
    return { internal: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}
