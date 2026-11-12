// The coverage gate, as `bunfig.toml` sets it: 80% of each file's lines, and no threshold on functions (ADW-562).
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('the coverage gate checks 80% of lines per file and gates no functions', () => {
  const config = Bun.TOML.parse(readFileSync(join(import.meta.dir, '..', 'bunfig.toml'), 'utf8')) as {
    test: { coverageThreshold: unknown };
  };
  expect(config.test.coverageThreshold).toEqual({ lines: 0.8, functions: 0 });
});
