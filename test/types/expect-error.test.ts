// The type tests: every `// @ts-expect-error TSnnnn: why` in test/types/*.ts must fail with the code it names.
// `bun run typecheck` alone only proves that each directive's line fails (TS2578 flags an unused one), not why.
// Here the directives are stripped from a temp copy, which `tsc` checks once, and each directive's next line must
// fail with exactly its code, while no other line fails at all.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const repo = join(import.meta.dir, '..', '..');
const DIRECTIVE = /^\s*\/\/\s*@ts-expect-error\b(.*)$/;
const CODE = /^\s+(TS\d+)\b/;
const DIAGNOSTIC = /^(.+)\((\d+),(\d+)\): error (TS\d+):/;

interface Directive {
  file: string;
  /** The 1-based line the directive covers: the one after it. */
  line: number;
  code: string | undefined;
}

const cases = [...new Bun.Glob('*.ts').scanSync({ cwd: import.meta.dir })]
  .filter((name) => !name.endsWith('.test.ts'))
  .sort();

const directives: Directive[] = [];
const stripped = new Map<string, string>();
for (const name of cases) {
  const lines = readFileSync(join(import.meta.dir, name), 'utf8').split('\n');
  lines.forEach((text, index) => {
    const match = DIRECTIVE.exec(text);
    if (match === null) return;
    directives.push({ file: name, line: index + 2, code: CODE.exec(match[1] ?? '')?.[1] });
    lines[index] = '//';
  });
  stripped.set(name, lines.join('\n'));
}

const dir = mkdtempSync(join(tmpdir(), 'sail-types-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('test/types holds case files with directives', () => {
  expect(cases).toContain('declarations.ts');
  expect(directives.length).toBeGreaterThan(0);
});

test('every directive names the code it expects', () => {
  const unnamed = directives.filter((d) => d.code === undefined).map((d) => `${d.file}:${d.line - 1}`);
  expect(unnamed).toEqual([]);
});

test('without its directive, each case fails with the code it names, and nothing else fails', () => {
  for (const [name, content] of stripped) writeFileSync(join(dir, name), content);
  // `paths` inherited through `extends` resolve against the root config, so `sail` still maps to src/sdk. Bun's
  // types don't resolve from a temp directory, and `types: []` also proves that the SDK uses no Bun APIs.
  const config = join(dir, 'tsconfig.json');
  writeFileSync(
    config,
    JSON.stringify({ extends: join(repo, 'tsconfig.json'), compilerOptions: { types: [] }, include: ['./*.ts'] }),
  );

  const tsc = Bun.spawnSync(
    [process.execPath, join(repo, 'node_modules/typescript/bin/tsc'), '--noEmit', '--pretty', 'false', '-p', config],
    { cwd: dir },
  );
  const output = tsc.stdout.toString();
  expect(tsc.exitCode).not.toBe(0);

  const found = new Map<string, string[]>();
  for (const line of output.split('\n')) {
    const match = DIAGNOSTIC.exec(line);
    if (match === null) continue;
    const [, path = '', row = '', , code = ''] = match;
    const at = `${basename(path)}:${row}`;
    found.set(at, [...(found.get(at) ?? []), code]);
  }

  const expected = new Map(directives.map((d) => [`${d.file}:${d.line}`, d.code ?? '']));
  const missing = [...expected].filter(([at]) => !found.has(at));
  const wrong = [...expected].filter(([at, code]) => found.get(at)?.some((got) => got !== code));
  const stray = [...found].filter(([at]) => !expected.has(at));
  expect({ missing, wrong: wrong.map(([at, code]) => [at, code, found.get(at)]), stray }).toEqual({
    missing: [],
    wrong: [],
    stray: [],
  });
  console.log(`${expected.size} expected type errors, each with its code`);
});
