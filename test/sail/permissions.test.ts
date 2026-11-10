// sail's own permission profiles: implement's `builder` writes any path of the repository but .git.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerSail } from '../../src/engine/definitions';
import { checkWrite } from '../../src/engine/permissions/paths';
import type { Permissions } from '../../src/sdk/steps';
import { makeLayout } from '../helpers/permissions';

const layout = makeLayout();
afterAll(() => layout.remove());
let builder: Permissions;
beforeAll(async () => {
  registerSail();
  builder = (
    (await import(join(import.meta.dir, '..', '..', '.sail', 'lib', 'permissions.ts'))) as { builder: Permissions }
  ).builder;
});

const PATHS = [
  'evals/run.py',
  '.vscode/settings.json',
  '.github/workflows/ci.yml',
  '.python-version',
  'pr-body.md',
  'src/a.ts',
];

function allowed(permissions: Permissions, paths: string[]): boolean[] {
  return paths.map((path) => checkWrite([path], permissions, layout.ctx).allow);
}

test('builder writes paths the old hand list missed, and still never .git', () => {
  expect([...allowed(builder, PATHS), ...allowed(builder, ['.git/config', '$STAGE_OUT/a.md'])]).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
    false,
    true,
  ]);
});

test('a ! glob added to builder denies just the paths it matches', () => {
  const narrowed = { ...builder, write: [...builder.write, '!.github/**'] };
  expect(allowed(narrowed, PATHS)).toEqual([true, true, false, true, true, true]);
});
