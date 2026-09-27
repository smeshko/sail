import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseDiagnostics, typecheck } from '../../src/engine/typecheck';
import { withTempRepo } from '../helpers/temp-repo';

const fixture = join(import.meta.dir, '..', 'fixtures', 'repo', '.sail');

function copyFixture(repoDir: string): string {
  const sail = join(repoDir, '.sail');
  cpSync(fixture, sail, { recursive: true });
  return sail;
}

function nodeModulesAbove(dir: string): string[] {
  const found: string[] = [];
  for (let at = dirname(dir); ; at = dirname(at)) {
    if (existsSync(join(at, 'node_modules'))) found.push(at);
    if (dirname(at) === at) return found;
  }
}

function nodeModulesWithin(dir: string): string[] {
  return [...new Bun.Glob('**/node_modules').scanSync({ cwd: dir, dot: true, onlyFiles: false })];
}

const BROKEN = "s.files['spec.md'], feedback";

test('a copy of the fixture .sail/ checks ok with no node_modules in reach', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    expect(nodeModulesAbove(repo.dir)).toEqual([]);
    expect(await typecheck(sail)).toEqual({ ok: true, files: 6 });
    expect(nodeModulesWithin(repo.dir)).toEqual([]);
  });
});

test('a wrongly wired binding is one TS2739 at its file and line', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const workflow = join(sail, 'workflows', 'ticket-to-pr', 'workflow.ts');
    const source = readFileSync(workflow, 'utf8');
    expect(source).toContain(BROKEN);
    const mutated = source.replace(BROKEN, 'run.input, feedback');
    writeFileSync(workflow, mutated);
    const line = mutated.split('\n').findIndex((text) => text.includes('run.input, feedback')) + 1;

    const result = await typecheck(sail);
    expect(result).toMatchObject({ ok: false, diagnostics: [{ file: workflow, line, code: 'TS2739' }] });
    if ('diagnostics' in result) {
      expect(result.diagnostics).toHaveLength(1);
      console.log(result.diagnostics[0]);
    }
  });
});

test("sail's house rules hold even when .sail/tsconfig.json turns strict off", async () => {
  await withTempRepo(async (repo) => {
    const sail = join(repo.dir, '.sail');
    mkdirSync(join(sail, 'lib'), { recursive: true });
    writeFileSync(join(sail, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: false } }));
    const rules = join(sail, 'lib', 'rules.ts');
    writeFileSync(
      rules,
      [
        'const list: string[] = [];',
        'export const first: string = list[0];',
        'export function untyped(x) {',
        '  return x;',
        '}',
        '',
      ].join('\n'),
    );

    const result = await typecheck(sail);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        { file: rules, line: 2, code: 'TS2322' },
        { file: rules, line: 3, code: 'TS7006' },
      ],
    });
  });
});

test('a .sail/ with no TypeScript checks ok without running tsc', async () => {
  await withTempRepo(async (repo) => {
    const sail = join(repo.dir, '.sail');
    mkdirSync(sail);
    writeFileSync(join(sail, 'project.yaml'), 'name: empty\n');
    expect(await typecheck(sail, { tsc: '/nowhere/tsc' })).toEqual({ ok: true, files: 0 });
  });
});

test('a tsc that cannot run is internal, and leaves no config behind', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const configs = () => readdirSync(tmpdir()).filter((name) => name.startsWith('sail-check-'));
    const before = configs();
    const result = await typecheck(sail, { tsc: join(repo.dir, 'missing', 'tsc') });
    expect(result).toHaveProperty('internal');
    if ('internal' in result) expect(result.internal).toContain('missing');
    expect(configs()).toEqual(before);
  });
});

test('parseDiagnostics reads a located diagnostic, resolving its file against cwd', () => {
  expect(
    parseDiagnostics(
      "../../.sail/workflows/a.ts(19,49): error TS2739: Type '{}' is missing properties.\n",
      '/repo/src/deep',
    ),
  ).toEqual([
    {
      file: '/repo/.sail/workflows/a.ts',
      line: 19,
      column: 49,
      code: 'TS2739',
      message: "Type '{}' is missing properties.",
    },
  ]);
});

test('parseDiagnostics reads a global diagnostic, a continuation and an unrecognised line', () => {
  const output = [
    "error TS18003: No inputs were found in config file '/tmp/x/tsconfig.json'.",
    '/abs/b.ts(3,1): error TS2322: Type A is not assignable to type B.',
    "  Property 'x' is missing.",
    '    Deeper.',
    '',
    'Found 2 errors.',
  ].join('\n');
  expect(parseDiagnostics(output, '/repo')).toEqual([
    { code: 'TS18003', message: "No inputs were found in config file '/tmp/x/tsconfig.json'." },
    {
      file: '/abs/b.ts',
      line: 3,
      column: 1,
      code: 'TS2322',
      message: "Type A is not assignable to type B.\n  Property 'x' is missing.\n    Deeper.",
    },
    { code: '', message: 'Found 2 errors.' },
  ]);
});

test('parseDiagnostics keeps an indented line with nothing before it', () => {
  expect(parseDiagnostics('  stray\n', '/repo')).toEqual([{ code: '', message: 'stray' }]);
});

test('with files, only those files and their imports are checked', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const workflow = join(sail, 'workflows', 'ticket-to-pr', 'workflow.ts');
    writeFileSync(workflow, readFileSync(workflow, 'utf8').replace(BROKEN, 'run.input, feedback'));
    const tests = join(sail, 'stages', 'tests', 'stage.ts');
    expect(await typecheck(sail, { files: [tests] })).toEqual({ ok: true, files: 1 });

    writeFileSync(join(sail, 'stages', 'tests', 'report.ts'), "export const total: number = 'none';\n");
    writeFileSync(tests, `import { total } from './report.ts';\n${readFileSync(tests, 'utf8')}\nexport { total };\n`);
    const result = await typecheck(sail, { files: [tests] });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ file: join(sail, 'stages', 'tests', 'report.ts'), code: 'TS2322' }],
    });
  });
});
