// The module that names the mktemp shim's folder and puts it first on a PATH.
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_ENV_FILE, SHIMS_DIR, shimsFirst } from '../../src/engine/shims';

const BIN = join(import.meta.dir, '..', '..', 'bin');

test('the constants name the shims folder and the session env file under bin/', () => {
  expect(SHIMS_DIR).toBe(join(BIN, 'shims'));
  expect(SESSION_ENV_FILE).toBe(join(BIN, 'session-env.sh'));
  expect(existsSync(join(SHIMS_DIR, 'mktemp'))).toBe(true);
});

test('shimsFirst puts the shims folder first, once', () => {
  expect(shimsFirst('/usr/bin')).toBe(`${SHIMS_DIR}:/usr/bin`);
  expect(shimsFirst(undefined)).toBe(`${SHIMS_DIR}:/usr/bin:/bin`);
  expect(shimsFirst('')).toBe(`${SHIMS_DIR}:/usr/bin:/bin`);
  expect(shimsFirst(undefined, '/x')).toBe(`${SHIMS_DIR}:/x`);
  expect(shimsFirst(shimsFirst('/usr/bin'))).toBe(shimsFirst('/usr/bin'));
});
