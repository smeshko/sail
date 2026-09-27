// types/ holds the SDK's committed declarations, which `sail check` type-checks a repository against. This test fails
// while they're stale: it emits a fresh copy and compares it with the committed one, byte for byte.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitTypes } from '../../scripts/types';

const committed = join(import.meta.dir, '..', '..', 'types');
const fresh = mkdtempSync(join(tmpdir(), 'sail-types-fresh-'));
let emitted: string[] = [];

beforeAll(async () => {
  emitted = await emitTypes(fresh);
});
afterAll(() => rmSync(fresh, { recursive: true, force: true }));

const stale = (name: string) => `types/${name} is stale: run \`bun run types\``;

test('types/ holds the entries sail check maps sail and sail/intakes to', () => {
  expect(existsSync(join(committed, 'index.d.ts'))).toBe(true);
  expect(existsSync(join(committed, 'intakes.d.ts'))).toBe(true);
});

test('a fresh emit gives the same files as types/', () => {
  const names = readdirSync(committed).sort();
  const extra = names.filter((name) => !emitted.includes(name)).map(stale);
  const missing = emitted.filter((name) => !names.includes(name)).map(stale);
  expect({ extra, missing }).toEqual({ extra: [], missing: [] });
});

test('each file in types/ matches a fresh emit', () => {
  const different = emitted
    .filter((name) => existsSync(join(committed, name)))
    .filter((name) => readFileSync(join(committed, name), 'utf8') !== readFileSync(join(fresh, name), 'utf8'))
    .map(stale);
  expect(different).toEqual([]);
});

test('every emitted file starts with the generated-file header', () => {
  expect(emitted.length).toBeGreaterThan(0);
  for (const name of emitted) {
    expect(readFileSync(join(fresh, name), 'utf8')).toStartWith(
      '// Generated from src/sdk by `bun run types`. Do not edit.\n',
    );
  }
});
