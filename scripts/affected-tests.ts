// Selects the tests a branch affects, for the pre-push hook's narrow gate (`bun run gate`). The full `bun run verify`
// stays CI's check. A branch's changes are every file that differs from its merge-base with the base branch, committed
// or not, plus untracked files. Each change selects its nearest tests: a changed test file selects itself, and any
// other file the tests that reach it through imports or through a path they name, such as
// `join(dir, '..', 'fixtures', 'runs')` or the CLI they spawn, at the fewest steps that reach any. The tests further
// out, which reach it only through the modules between, are left to CI.
//
//   bun scripts/affected-tests.ts           runs the selected tests, or every test when it can't narrow
//   bun scripts/affected-tests.ts --list    prints the selection, one test file per line
//   --base <ref>                            the base branch, `origin/staging` by default
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fullSuiteAllowed } from './full-suite';

const checkout = join(import.meta.dir, '..');

/** Changes that reach every test: the toolchain, the test launcher and preload, and the coverage census. */
export const EVERYTHING = [
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'tsconfig.json',
  'scripts/test.ts',
  'test/setup.ts',
  'test/coverage-census.test.ts',
];

/**
 * Changes no test reads: prose, CI and hook config, the linter's config, which `bun run lint` checks, and sail's own
 * `.sail/`, which `sail check` checks. The tests' repositories live under test/fixtures/.
 */
const UNTESTED = [
  /^docs\//,
  /^\.sail\//,
  /^\.github\//,
  /^\.githooks\//,
  /^[^/]+\.md$/,
  /^LICENSE$/,
  /^\.gitignore$/,
  /^biome\.json$/,
];

/** Where the files that import or name other files live. test/fixtures is data, reached through the paths it's at. */
const CODE = ['src', 'scripts', 'test', 'bin'];
const TESTED = [...CODE, 'schemas', 'types'];

/** The tsconfig paths a repository's `.sail/` code and the type tests import sail through. */
const ALIASES: Record<string, string> = { sail: 'src/sdk/index.ts', 'sail/intakes': 'src/sdk/intakes.ts' };

export type Selection =
  | { readonly kind: 'all'; readonly reason: string }
  | { readonly kind: 'some'; readonly tests: readonly string[] };

const IMPORT = /\b(?:from|import)\s*\(?\s*(['"])([^'"\n]+)\1/g;
const LITERAL = String.raw`(?:'[^'\n]*'|"[^"\n]*"|\`[^\`\n]*\`)`;
const LITERALS = new RegExp(`${LITERAL}(?:\\s*,\\s*${LITERAL})*`, 'g');
const CLEAN = /^[\w.@-]+$/;

/** The repository files a module imports, resolved to paths from the checkout's root. Packages are left out. */
export function importsOf(path: string, text: string, exists: (path: string) => boolean): string[] {
  const found: string[] = [];
  for (const [, , specifier = ''] of text.matchAll(IMPORT)) {
    const alias = ALIASES[specifier];
    if (alias) found.push(alias);
    if (!specifier.startsWith('.')) continue;
    const base = normalize(join(dirname(path), specifier));
    const hit = [base, `${base}.ts`, join(base, 'index.ts')].find(exists);
    found.push(hit ?? base);
  }
  return found;
}

/**
 * The paths a module names outside its imports, as path segments: each run of adjacent string literals, as in
 * `join(dir, '..', 'fixtures', 'runs')`, read as one path. A lone literal counts only when it holds a `/` or names a
 * file, so `'test'` or `'repo'` on their own name nothing.
 */
export function pathsNamedIn(text: string): string[][] {
  const named: string[][] = [];
  for (const [run] of text.replace(IMPORT, '').matchAll(LITERALS)) {
    const literals = run.split(/\s*,\s*/).map((literal) => literal.slice(1, -1));
    const parts = literals.flatMap((literal) => literal.split('/'));
    const tail = parts.slice(parts.findLastIndex((part) => !CLEAN.test(part)) + 1);
    const segments = tail.filter((part) => part !== '.' && part !== '..');
    if (segments.length === 0) continue;
    const isFile = segments.length === 1 && /^[^.].*\.[a-z0-9]+$/i.test(segments[0] ?? '');
    if (literals.length > 1 || run.includes('/') || isFile) named.push(segments);
  }
  return named;
}

/**
 * Whether the file at `from` naming `segments` depends on `path`: the segments appear, in order and adjacent, among the
 * segments of `path`. Data is reached by any name. Code is reached only from outside src, which names code it runs,
 * such as bin/sail for script steps, without its tests running it, and only by a name of two or more segments, so a
 * test writing a temp `main.ts` doesn't depend on src/cli/main.ts.
 */
function names(from: string, segments: readonly string[], path: string): boolean {
  if (isCode(path) && (from.startsWith('src/') || segments.length < 2)) return false;
  const parts = path.split('/');
  for (let at = 0; at + segments.length <= parts.length; at++) {
    if (segments.every((segment, offset) => parts[at + offset] === segment)) return true;
  }
  return false;
}

const isTest = (path: string) => path.startsWith('test/') && path.endsWith('.test.ts');
const isCode = (path: string) => path.endsWith('.ts') || path.startsWith('bin/');

/** The files of the checkout at `root` that import or name others, with the edges read from each. */
function readGraph(root: string): Map<string, { imports: string[]; named: string[][] }> {
  const exists = (path: string) => existsSync(join(root, path)) && statSync(join(root, path)).isFile();
  const graph = new Map<string, { imports: string[]; named: string[][] }>();
  for (const dir of CODE) {
    if (!existsSync(join(root, dir))) continue;
    for (const name of new Bun.Glob('**/*').scanSync({ cwd: join(root, dir) })) {
      const path = `${dir}/${name}`;
      if (path.startsWith('test/fixtures/') || !(path.endsWith('.ts') || dir === 'bin')) continue;
      const text = readFileSync(join(root, path), 'utf8');
      graph.set(path, { imports: importsOf(path, text, exists), named: pathsNamedIn(text) });
    }
  }
  return graph;
}

/** The test files of the checkout at `root` that `changed` affects, or every test when a change reaches them all. */
export function selectTests(root: string, changed: readonly string[]): Selection {
  const everything = changed.find((path) => EVERYTHING.includes(path));
  if (everything) return { kind: 'all', reason: `${everything} changed` };
  const relevant = changed.filter((path) => !UNTESTED.some((pattern) => pattern.test(path)));
  const unplaced = relevant.find((path) => !TESTED.includes(path.split('/')[0] ?? ''));
  if (unplaced) return { kind: 'all', reason: `${unplaced} changed, and no rule says which tests it reaches` };

  const graph = readGraph(root);
  const dependents = new Map<string, string[]>();
  /** The files that import or name `target`. */
  const reaching = (target: string): string[] => {
    let found = dependents.get(target);
    if (!found) {
      found = [...graph]
        .filter(([path, { imports, named }]) => {
          if (path === target) return false;
          return imports.includes(target) || named.some((segments) => names(path, segments, target));
        })
        .map(([path]) => path);
      dependents.set(target, found);
    }
    return found;
  };
  const tests = new Set<string>();
  for (const path of relevant) {
    // Walk out from the change a step at a time, and stop at the first step that holds a test. A helper or a type-test
    // case also selects the tests beside it, which may read it without importing it, and the walk goes on past them.
    const seen = new Set([path]);
    for (let step = [path]; step.length > 0; ) {
      const reached = step.filter((file) => isTest(file) && graph.has(file));
      const helpers = new Set(step.filter((file) => file.startsWith('test/') && !isTest(file)).map(dirname));
      for (const file of graph.keys()) if (isTest(file) && helpers.has(dirname(file))) tests.add(file);
      if (reached.length > 0) {
        for (const file of reached) tests.add(file);
        break;
      }
      step = step.flatMap(reaching).filter((next) => !seen.has(next) && Boolean(seen.add(next)));
    }
  }
  return { kind: 'some', tests: [...tests].sort() };
}

/** Runs git in `root`: its stdout, or undefined when it fails. */
function git(root: string, env: Record<string, string | undefined>, ...args: string[]): string | undefined {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, env });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

/** The files that differ from the merge-base with `base`, committed, staged, unstaged or untracked: undefined when there's no merge-base. */
export function changedFiles(
  root: string,
  base: string,
  env: Record<string, string | undefined> = process.env,
): string[] | undefined {
  const mergeBase = git(root, env, 'merge-base', 'HEAD', base)?.trim();
  if (!mergeBase) return undefined;
  const diffed = git(root, env, 'diff', '--name-only', '--no-renames', mergeBase) ?? '';
  const untracked = git(root, env, 'ls-files', '--others', '--exclude-standard') ?? '';
  const lines = `${diffed}\n${untracked}`.split('\n').filter(Boolean);
  return [...new Set(lines)].sort();
}

/** The selection for the checkout at `root` against `base`: every test when there's no merge-base, as in a shallow clone. */
export function affectedTests(
  root: string,
  base: string,
  env: Record<string, string | undefined> = process.env,
): Selection {
  const changed = changedFiles(root, base, env);
  if (!changed) return { kind: 'all', reason: `no merge-base with ${base}` };
  return selectTests(root, changed);
}

/** Every test file of the checkout at `root`, for --list when the selection is all of them. */
export function allTests(root: string): string[] {
  return [...new Bun.Glob('test/**/*.test.ts').scanSync({ cwd: root })]
    .filter((path) => !path.startsWith('test/fixtures/'))
    .sort();
}

/**
 * The arguments for scripts/test.ts that run `selection` with a generous timeout: undefined when it's empty, or when
 * it's every test and `env` isn't CI's, since CI's verify runs them all. Every test means every test under test/: left
 * without a path, Bun runs any `*.test.ts` in the checkout, the ignored plan drafts under docs/ included.
 */
export function testArgs(
  selection: Selection,
  env: Record<string, string | undefined> = process.env,
): string[] | undefined {
  const timeout = ['--timeout', '60000'];
  if (selection.kind === 'all') return fullSuiteAllowed(env) ? [...timeout, './test'] : undefined;
  if (selection.tests.length === 0) return undefined;
  return [...timeout, ...selection.tests.map((path) => `./${path}`)];
}

/**
 * What the gate says before it runs: why it runs every test or leaves them to CI, how many it selected, or that it skips
 * them.
 */
export function describe(selection: Selection, env: Record<string, string | undefined> = process.env): string {
  if (selection.kind === 'all') {
    const why = `affected tests: every test, because ${selection.reason}`;
    if (fullSuiteAllowed(env)) return why;
    return `${why}. CI's verify runs them, so the test step is skipped here (SAIL_FULL_SUITE=1 runs them)`;
  }
  if (selection.tests.length === 0) return 'affected tests: none, so the test step is skipped';
  return `affected tests: ${selection.tests.length} file${selection.tests.length === 1 ? '' : 's'}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--base');
  const selection = affectedTests(checkout, at === -1 ? 'origin/staging' : (args[at + 1] ?? ''));
  console.error(describe(selection));
  if (args.includes('--list')) {
    const tests = selection.kind === 'all' ? allTests(checkout) : selection.tests;
    for (const path of tests) console.log(path);
  } else {
    const testing = testArgs(selection);
    if (testing) {
      const child = Bun.spawn([process.execPath, join(checkout, 'scripts/test.ts'), ...testing], {
        cwd: checkout,
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      process.exit(await child.exited);
    }
  }
}
