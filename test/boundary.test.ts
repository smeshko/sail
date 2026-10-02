// The import boundary (D11): the core (the engine, kinds, events, ports and the SDK) never imports an adapter, and
// imports no package outside an allowlist, so a provider SDK can't slip in either. The composition roots, src/cli,
// src/watch and src/dashboard, hand adapters in.
//
// TypeScript 7 has no JS API, so two readings are joined. Bun's transpiler parses every import that runs, whatever
// comments or quotes surround it, but drops type-only imports. The source text, with its comments blanked, gives those,
// and `import.meta.require`. A specifier inside a string is reported too, which fails safe.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const root = join(import.meta.dir, '..');
const CORE = ['src/engine', 'src/kinds', 'src/events', 'src/ports', 'src/sdk'];
/** What the core may not import: the adapters, and the composition roots that import them. */
const OUTSIDE: [string, string][] = [
  ['src/adapters', 'src/adapters'],
  ['src/cli', 'a composition root'],
  ['src/watch', 'a composition root'],
  ['src/dashboard', 'a composition root'],
];

/** The bare specifiers the core may import: node and bun built-ins, zod and ajv. */
const ALLOWED = /^(node:.+|bun:.+|bun|zod|ajv|ajv\/.+)$/;

const FORMS = [
  // import … from '…', import type … from '…' and export … from '…', over several lines
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*(['"`])(.*?)\1/g,
  // a side-effect import '…'
  /\bimport\s*(['"`])(.*?)\1/g,
  // import('…', …), require('…'), import x = require('…') and import.meta.require('…')
  /\b(?:import|require)\s*\(\s*(['"`])(.*?)\1/g,
];

/** The words after which a `/` starts a regular expression rather than dividing. */
const BEFORE_REGEX = /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

/** Whether a `/` after `before` divides: it follows an operand, such as a name, a number or a closing bracket. */
function divides(before: string): boolean {
  const code = before.trimEnd();
  const word = /[\w$]+$/.exec(code)?.[0];
  if (word !== undefined) return !BEFORE_REGEX.test(word);
  return /[)\]]$/.test(code);
}

/**
 * `source` with each comment blanked, keeping its newlines, so a quote inside a comment can't hide an import. Strings,
 * templates and regular expressions are copied whole, escapes included.
 */
function withoutComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (c === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : next === '/' ? close : close + 2;
      out += source.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`' || (c === '/' && !divides(out))) {
      let j = i + 1;
      let inClass = false;
      for (; j < source.length; j++) {
        const d = source[j];
        if (d === '\\') j++;
        else if (c === '/' && d === '[') inClass = true;
        else if (c === '/' && d === ']') inClass = false;
        else if ((d === c && !inClass) || (d === '\n' && c !== '`')) break;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const transpiler = new Bun.Transpiler({ loader: 'ts' });

/** Every module specifier in `source` written out whole: a template holding `${…}` is computed, and can't be checked. */
function specifiers(source: string): string[] {
  const text = withoutComments(source);
  const read = FORMS.flatMap((form) => [...text.matchAll(form)].map((match) => match[2] ?? ''));
  const parsed = transpiler.scanImports(source).map((entry) => entry.path);
  return [...new Set([...read, ...parsed])].filter((specifier) => !specifier.includes('${'));
}

/** How `source`, the text of `file` (relative to the repository), breaks the boundary. */
function violations(file: string, source: string): string[] {
  return specifiers(source).flatMap((specifier) => {
    if (specifier.startsWith('.') || isAbsolute(specifier)) {
      const target = resolve(root, dirname(file), specifier);
      return OUTSIDE.flatMap(([dir, what]) => {
        const inside = relative(join(root, dir), target);
        return inside.startsWith('..') || isAbsolute(inside) ? [] : [`${file}: imports ${specifier} (${what})`];
      });
    }
    return ALLOWED.test(specifier) ? [] : [`${file}: imports ${specifier} (not allowlisted)`];
  });
}

test('each planted import of an adapter, a composition root or an unlisted package is reported, naming the file', () => {
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
    // Quotes in comments, other quotes, and the other ways a module is loaded.
    ['src/engine/x.ts', "import {\n  // the fake's host\n  createFakeCodeHost,\n} from '../adapters/fake/index';"],
    ['src/engine/x.ts', "import type {\n  // the fake's world\n  FakeWorld,\n} from '../adapters/fake/world';"],
    ['src/engine/x.ts', "/* it's */ import { y } from '../adapters/after-comment';"],
    ['src/engine/x.ts', "const quote = /'/; import { x } from '../adapters/after-regex';"],
    ['src/engine/x.ts', "const sdk = await import(/* the SDK's */ '@linear/sdk');"],
    ['src/engine/x.ts', 'const host = await import(`../adapters/fake/code-host`);'],
    ['src/engine/x.ts', "const data = await import('../adapters/data.json', { with: { type: 'json' } });"],
    ['src/engine/x.ts', "const leases = require('../adapters/leases');"],
    ['src/engine/x.ts', "import leases = require('../adapters/leases');"],
    ['src/engine/x.ts', "const sdk = import.meta.require('@linear/sdk');"],
    // A composition root imports adapters, so importing one brings them into the core.
    ['src/engine/x.ts', "import { EXIT } from '../cli/exit-codes';"],
    ['src/kinds/x.ts', "import { startWatcher } from '../watch/index';"],
    ['src/sdk/x.ts', "import type { Board } from '../dashboard/board';"],
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
    'src/engine/x.ts: imports ../adapters/fake/index (src/adapters)',
    'src/engine/x.ts: imports ../adapters/fake/world (src/adapters)',
    'src/engine/x.ts: imports ../adapters/after-comment (src/adapters)',
    'src/engine/x.ts: imports ../adapters/after-regex (src/adapters)',
    'src/engine/x.ts: imports @linear/sdk (not allowlisted)',
    'src/engine/x.ts: imports ../adapters/fake/code-host (src/adapters)',
    'src/engine/x.ts: imports ../adapters/data.json (src/adapters)',
    'src/engine/x.ts: imports ../adapters/leases (src/adapters)',
    'src/engine/x.ts: imports ../adapters/leases (src/adapters)',
    'src/engine/x.ts: imports @linear/sdk (not allowlisted)',
    'src/engine/x.ts: imports ../cli/exit-codes (a composition root)',
    'src/kinds/x.ts: imports ../watch/index (a composition root)',
    'src/sdk/x.ts: imports ../dashboard/board (a composition root)',
  ]);
});

test('the allowlisted packages, and relative imports outside src/adapters and the composition roots, are not reported', () => {
  const allowed = [
    "import { readFileSync } from 'node:fs';",
    "import { z } from 'zod';",
    "import Ajv2020 from 'ajv/dist/2020';",
    "import { version } from '../../package.json';",
    "import type { Ticket } from '../ports/types';",
    "import { resolveAdapters } from '../adapters-registry';",
    // An import in a comment loads nothing, and a computed one can't be read.
    "// import { createFakeHarness } from '../adapters/fake/harness';",
    "/* const sdk = await import('@linear/sdk'); */",
    `const stage = await import(\`\${dir}/stage.ts\`);`,
    // A `/` that divides doesn't start a regular expression that would swallow the quotes after it.
    "const half = total / 2; const name = 'a'; import { z } from 'zod';",
  ];
  expect(allowed.flatMap((source) => violations('src/engine/x.ts', source))).toEqual([]);
});

test('no core module imports an adapter, a composition root or an unlisted package', () => {
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
