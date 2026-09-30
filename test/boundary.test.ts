// The import boundary (D11): the core (the engine, kinds, events, ports and the SDK) never imports an adapter, and
// imports no package outside an allowlist, so a provider SDK can't slip in either. The composition roots, src/cli,
// src/watch and src/dashboard, hand adapters in. TypeScript 7 has no JS API, so this reads the source text: a
// specifier inside a comment is reported too, which fails safe.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const root = join(import.meta.dir, '..');
const CORE = ['src/engine', 'src/kinds', 'src/events', 'src/ports', 'src/sdk'];
const ADAPTERS = join(root, 'src', 'adapters');

/** The bare specifiers the core may import: node and bun built-ins, zod and ajv. */
const ALLOWED = /^(node:.+|bun:.+|bun|zod|ajv|ajv\/.+)$/;

const FORMS = [
  // import … from '…', import type … from '…' and export … from '…', over several lines
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // a side-effect import '…'
  /\bimport\s*['"]([^'"]+)['"]/g,
  // a literal import('…')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Every module specifier in `source`. */
function specifiers(source: string): string[] {
  return FORMS.flatMap((form) => [...source.matchAll(form)].map((match) => match[1] ?? ''));
}

/** How `source`, the text of `file` (relative to the repository), breaks the boundary. */
function violations(file: string, source: string): string[] {
  return specifiers(source).flatMap((specifier) => {
    if (specifier.startsWith('.') || isAbsolute(specifier)) {
      const inside = relative(ADAPTERS, resolve(root, dirname(file), specifier));
      return inside.startsWith('..') || isAbsolute(inside) ? [] : [`${file}: imports ${specifier} (src/adapters)`];
    }
    return ALLOWED.test(specifier) ? [] : [`${file}: imports ${specifier} (not allowlisted)`];
  });
}

test('each planted import of an adapter or an unlisted package is reported, naming the file and the specifier', () => {
  const planted: [string, string][] = [
    ['src/engine/x.ts', "import { createFakeTicketSource } from '../adapters/fake/index';"],
    ['src/engine/x.ts', "import type { X } from '../adapters/fake';"],
    ['src/engine/x.ts', "const leases = await import('../adapters/leases');"],
    ['src/engine/x.ts', "import '../adapters/index';"],
    ['src/engine/x.ts', "import {\n  createFakeCodeHost,\n  createFakeWorkspace,\n} from '../adapters/fake/index';"],
    ['src/ports/x.ts', "export { takeLease } from '../adapters/leases';"],
    ['src/sdk/deep/x.ts', "import { createFakeHarness } from '../../adapters/fake/harness';"],
    ['src/engine/x.ts', "import { LinearClient } from '@linear/sdk';"],
    ['src/kinds/x.ts', "import { z } from 'zodiac';"],
  ];
  expect(planted.flatMap(([file, source]) => violations(file, source))).toEqual([
    'src/engine/x.ts: imports ../adapters/fake/index (src/adapters)',
    'src/engine/x.ts: imports ../adapters/fake (src/adapters)',
    'src/engine/x.ts: imports ../adapters/leases (src/adapters)',
    'src/engine/x.ts: imports ../adapters/index (src/adapters)',
    'src/engine/x.ts: imports ../adapters/fake/index (src/adapters)',
    'src/ports/x.ts: imports ../adapters/leases (src/adapters)',
    'src/sdk/deep/x.ts: imports ../../adapters/fake/harness (src/adapters)',
    'src/engine/x.ts: imports @linear/sdk (not allowlisted)',
    'src/kinds/x.ts: imports zodiac (not allowlisted)',
  ]);
});

test('the allowlisted packages and relative imports outside src/adapters are not reported', () => {
  const allowed = [
    "import { readFileSync } from 'node:fs';",
    "import { z } from 'zod';",
    "import Ajv2020 from 'ajv/dist/2020';",
    "import { version } from '../../package.json';",
    "import type { Ticket } from '../ports/types';",
    "import { resolveAdapters } from '../adapters-registry';",
  ];
  expect(allowed.flatMap((source) => violations('src/engine/x.ts', source))).toEqual([]);
});

test('no core module imports an adapter or an unlisted package', () => {
  const scanned: Record<string, number> = {};
  const found: string[] = [];
  for (const dir of CORE) {
    const files = [...new Bun.Glob('**/*.ts').scanSync({ cwd: join(root, dir) })].map((path) => `${dir}/${path}`);
    scanned[dir] = files.length;
    for (const file of files) found.push(...violations(file, readFileSync(join(root, file), 'utf8')));
  }
  console.log(
    `scanned ${Object.values(scanned).reduce((sum, n) => sum + n, 0)} core files: ${JSON.stringify(scanned)}`,
  );
  expect(CORE.filter((dir) => scanned[dir] === 0)).toEqual([]);
  expect(found).toEqual([]);
});
