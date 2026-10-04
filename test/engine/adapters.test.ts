// The adapter registry: the config's four adapter entries become four adapters, a built-in found by name among the
// definitions it is handed or the repository's own module imported by path. Anything it can't resolve, create or
// recognise as its port is an issue at /adapters/<port>, the credentials come before anything is created, and each
// entry records the versions its adapter declares (DECISIONS D6, D9 to D12).
//
// Each test has a repository of its own: a module's path is its own, because Bun caches a failed import per path.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUILTINS } from '../../src/adapters/index';
import { type ResolvedAdapters, resolveAdapters } from '../../src/engine/adapters';
import { type AdapterConfig, PORTS, type Port, type ProjectConfig } from '../../src/engine/config';
import { runsDir } from '../../src/engine/run-dir';
import { type AdapterEntry, type RunHeader, validateRunHeader } from '../../src/engine/run-header';
import type { SchemaIssue } from '../../src/engine/schemas';
import type { Builtins, Env } from '../../src/ports/adapter';
import { stubAdapter } from '../helpers/adapters';

const GOLDEN = join(import.meta.dir, '..', 'fixtures', 'runs', 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N', 'run.json');
const FAKE: AdapterEntry = { use: 'fake', origin: 'builtin' };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repository root and its `.sail/`, by real path. */
function repo(): { root: string; sailDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sail-adapters-')));
  roots.push(root);
  const sailDir = join(root, '.sail');
  mkdirSync(sailDir);
  return { root, sailDir };
}

/** Writes `source` to `path` under `dir`, making its folder. */
function write(dir: string, path: string, source: string): void {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}

/** A config naming `use` for each port in `adapters`, and the fake for the rest. */
function configOf(adapters: Partial<Record<Port, AdapterConfig>>): ProjectConfig {
  const fake = { use: 'fake' };
  return {
    name: 'test',
    sail: '>=0.0.0',
    adapters: { ticketSource: fake, codeHost: fake, harness: fake, workspace: fake, ...adapters },
    models: {},
    budgets: {},
  };
}

interface Extras {
  builtins?: Builtins;
  env?: Env;
  emit?: (event: never) => void;
}

/** Resolves `adapters` from `sailDir`, the fake built in beside any `builtins` a test adds. */
function resolve(sailDir: string, adapters: Partial<Record<Port, AdapterConfig>>, extras: Extras = {}) {
  const { builtins = {}, env = {}, emit } = extras;
  return resolveAdapters({
    sailDir,
    config: configOf(adapters),
    builtins: { ...BUILTINS, ...builtins },
    env,
    ...(emit === undefined ? {} : { emit: emit as never }),
  });
}

/** Built-in definitions for `port`, which a test hands the registry as the built-in `name`. */
function builtin(name: string, port: Port, definition: object): Builtins {
  return { [name]: { [port]: definition } } as unknown as Builtins;
}

/** The adapter for `port` as a definition's `create` returns it, counting each creation in `made`. */
function counting(port: Port, made: string[], label = port): object {
  return {
    create: () => {
      made.push(label);
      return stubAdapter(port);
    },
  };
}

const issue = (port: Port, message: string): { issues: SchemaIssue[] } => ({
  issues: [{ path: `/adapters/${port}`, message } as SchemaIssue],
});

const resolvedOrThrow = (result: ResolvedAdapters | { issues: SchemaIssue[] }): ResolvedAdapters => {
  if ('issues' in result) throw new Error(JSON.stringify(result.issues));
  return result;
};

/** A harness module's source: a harness named echo, with the `extra` members. */
const HARNESS_CAPABILITIES = '{ structuredOutput: true, permissions: true, usage: true, abort: true, budgets: [] }';
const harnessModule = (extra = '') =>
  `export default { create() { return { name: 'echo', capabilities: () => (${HARNESS_CAPABILITIES}), run: async () => ({}) }; }, ${extra} };`;

// TASK-004

test('all four ports on the fake resolve to four adapters named fake, and four builtin entries', async () => {
  const { sailDir } = repo();
  const resolved = resolvedOrThrow(await resolve(sailDir, {}));
  expect(PORTS.map((port) => resolved.ports[port]?.name)).toEqual(['fake', 'fake', 'fake', 'fake']);
  expect(resolved.entries).toEqual({ ticketSource: FAKE, codeHost: FAKE, harness: FAKE, workspace: FAKE });
});

test("a module harness gets its entry's options and a context, and its entry names the module as its origin", async () => {
  const { root, sailDir } = repo();
  write(
    sailDir,
    'adapters/echo.ts',
    `export default { create(options, context) {
      globalThis.__seenByEcho = { options, context };
      return { name: 'echo', capabilities: () => (${HARNESS_CAPABILITIES}), run: async () => ({}) };
    } };`,
  );
  const env = { SAIL_TEST: '1' };
  const emit = () => undefined;
  const resolved = resolvedOrThrow(
    await resolve(sailDir, { harness: { use: './adapters/echo.ts', greeting: 'hi' } }, { env, emit }),
  );
  expect(resolved.ports.harness?.name).toBe('echo');
  expect(resolved.entries.harness).toEqual({ use: './adapters/echo.ts', origin: 'repo:.sail/adapters/echo.ts' });
  const seen = (globalThis as unknown as { __seenByEcho: { options: unknown; context: Record<string, unknown> } })
    .__seenByEcho;
  expect(seen.options).toEqual({ greeting: 'hi' });
  expect(seen.context).toEqual({ root, sailDir, runsDir: runsDir(sailDir), env, emit });
  expect(seen.context.env).toBe(env);
  expect(seen.context.emit).toBe(emit);
});

test('a module whose create is async is awaited, and a module that imports sail loads', async () => {
  const { sailDir } = repo();
  write(
    sailDir,
    'adapters/later.ts',
    `import { z } from 'sail';
    export default { async create() {
      await Promise.resolve();
      return { name: z.string().parse('later'), capabilities: () => (${HARNESS_CAPABILITIES}), run: async () => ({}) };
    } };`,
  );
  const resolved = resolvedOrThrow(await resolve(sailDir, { harness: { use: './adapters/later.ts' } }));
  expect(resolved.ports.harness?.name).toBe('later');
});

test("a module outside .sail/ but inside the repository records its origin from the repository's root", async () => {
  const { root, sailDir } = repo();
  write(root, 'shared/harness.ts', harnessModule());
  const resolved = resolvedOrThrow(await resolve(sailDir, { harness: { use: '../shared/harness.ts' } }));
  expect(resolved.entries.harness).toEqual({ use: '../shared/harness.ts', origin: 'repo:shared/harness.ts' });
});

interface Broken {
  label: string;
  port: Port;
  use: string;
  /** A module to write under `.sail/`, by its path there. */
  module?: [string, string];
  builtins?: Builtins;
  message: string;
}

const NO_DEFINITION = 'default-exports no adapter definition: an object with create()';
const OPEN_HARNESS = {
  create: () =>
    stubAdapter('harness', (a) => {
      const base = a.capabilities as () => object;
      a.capabilities = () => ({ ...base(), permissions: false });
    }),
};

const broken: Broken[] = [
  {
    label: 'an unknown built-in',
    port: 'codeHost',
    use: 'githb',
    message: "no built-in adapter 'githb' fills codeHost: the built-ins that do are fake",
  },
  {
    label: 'a built-in that fills another port',
    port: 'ticketSource',
    use: 'only',
    builtins: {
      ...builtin('only', 'harness', counting('harness', [])),
      ...builtin('other', 'ticketSource', counting('ticketSource', [])),
    },
    message: "no built-in adapter 'only' fills ticketSource: the built-ins that do are fake, other",
  },
  {
    label: 'a path outside the repository',
    port: 'harness',
    use: '../../outside.ts',
    message: "'../../outside.ts' is outside the repository",
  },
  {
    label: 'a path with no file',
    port: 'harness',
    use: './adapters/nope.ts',
    message: ".sail/adapters/nope.ts doesn't exist",
  },
  {
    label: 'a module that throws on import',
    port: 'harness',
    use: './adapters/boom.ts',
    module: ['adapters/boom.ts', "throw new Error('boom');"],
    message: '.sail/adapters/boom.ts failed to load: boom',
  },
  {
    label: 'a module with no default export',
    port: 'harness',
    use: './adapters/none.ts',
    module: ['adapters/none.ts', 'export const x = 1;'],
    message: `.sail/adapters/none.ts ${NO_DEFINITION}`,
  },
  {
    label: 'a function as the default export',
    port: 'harness',
    use: './adapters/function.ts',
    module: ['adapters/function.ts', 'export default function () {}'],
    message: `.sail/adapters/function.ts ${NO_DEFINITION}`,
  },
  {
    label: 'a default export without create',
    port: 'harness',
    use: './adapters/nocreate.ts',
    module: ['adapters/nocreate.ts', 'export default { requires: () => [] };'],
    message: `.sail/adapters/nocreate.ts ${NO_DEFINITION}`,
  },
  {
    label: 'a versions that is not a function',
    port: 'harness',
    use: './adapters/badversions.ts',
    module: ['adapters/badversions.ts', 'export default { create() {}, versions: 3 };'],
    message: `.sail/adapters/badversions.ts ${NO_DEFINITION}`,
  },
  {
    label: 'a create that throws',
    port: 'harness',
    use: './adapters/throws.ts',
    module: ['adapters/throws.ts', "export default { create() { throw new Error('nope'); } };"],
    message: './adapters/throws.ts could not be created: nope',
  },
  {
    label: 'a create that returns a string',
    port: 'harness',
    use: './adapters/string.ts',
    module: ['adapters/string.ts', "export default { create: () => 'x' };"],
    message: './adapters/string.ts is not an adapter: it has no name',
  },
  {
    label: 'an adapter with no name',
    port: 'workspace',
    use: 'nameless',
    builtins: builtin('nameless', 'workspace', {
      create: () => stubAdapter('workspace', (a) => Reflect.deleteProperty(a, 'name')),
    }),
    message: 'nameless is not an adapter: it has no name',
  },
  {
    label: 'a harness without run',
    port: 'harness',
    use: 'norun',
    builtins: builtin('norun', 'harness', {
      create: () => stubAdapter('harness', (a) => Reflect.deleteProperty(a, 'run')),
    }),
    message: "norun doesn't implement harness: run() is missing",
  },
  {
    label: 'a module harness reporting no permissions',
    port: 'harness',
    use: './adapters/open.ts',
    module: ['adapters/open.ts', harnessModule().replace('permissions: true', 'permissions: false')],
    message: './adapters/open.ts enforces no permissions, which only the built-in fake may',
  },
];

test.each(broken)(
  '$label is one issue at its port, with no run directory made',
  async ({ port, use, module, builtins, message }) => {
    const { root, sailDir } = repo();
    if (module !== undefined) write(sailDir, ...module);
    const result = await resolve(sailDir, { [port]: { use } }, builtins === undefined ? {} : { builtins });
    expect(result).toEqual(issue(port, message));
    expect(JSON.stringify(readdirDeep(root))).not.toContain('.sail-runs');
  },
);

/** Every path under `root`, relative: what a refused resolve must not have added to. */
function readdirDeep(root: string): string[] {
  return [...new Bun.Glob('**/*').scanSync({ cwd: root, dot: true, onlyFiles: false })];
}

test.each<[string, string, string]>([
  ['the repository itself', '../', "'../' is outside the repository"],
  ['a folder', './adapters', '.sail/adapters is not a file'],
])('a module path to %s is one issue at its port', async (_, use, message) => {
  const { sailDir } = repo();
  write(sailDir, 'adapters/echo.ts', harnessModule());
  expect(await resolve(sailDir, { harness: { use } })).toEqual(issue('harness', message));
});

test("a folder in the repository whose name starts with '..' is inside it", async () => {
  const { root, sailDir } = repo();
  write(root, '..shared/harness.ts', harnessModule());
  const resolved = resolvedOrThrow(await resolve(sailDir, { harness: { use: '../..shared/harness.ts' } }));
  expect(resolved.entries.harness).toEqual({ use: '../..shared/harness.ts', origin: 'repo:..shared/harness.ts' });
});

/** A folder outside every repository, holding a harness module that marks `flag` on `globalThis` when it is imported. */
function outside(flag: string): { dir: string; file: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-outside-')));
  roots.push(dir);
  const file = join(dir, 'harness.ts');
  writeFileSync(file, `globalThis.${flag} = true;\n${harnessModule()}`);
  return { dir, file };
}

const marked = (flag: string) => (globalThis as Record<string, unknown>)[flag];

test('a module path that is a symlink to a file outside the repository is refused before it is imported', async () => {
  const { root, sailDir } = repo();
  const { file } = outside('__importedThroughFileLink');
  mkdirSync(join(sailDir, 'adapters'));
  symlinkSync(file, join(sailDir, 'adapters', 'link.ts'));
  const result = await resolve(sailDir, { harness: { use: './adapters/link.ts' } });
  expect(result).toEqual(issue('harness', '.sail/adapters/link.ts links outside the repository'));
  expect(marked('__importedThroughFileLink')).toBeUndefined();
  expect(JSON.stringify(readdirDeep(root))).not.toContain('.sail-runs');
});

test('a module path through a symlinked folder outside the repository is refused before it is imported', async () => {
  const { sailDir } = repo();
  const { dir } = outside('__importedThroughFolderLink');
  symlinkSync(dir, join(sailDir, 'linked'));
  const result = await resolve(sailDir, { harness: { use: './linked/harness.ts' } });
  expect(result).toEqual(issue('harness', '.sail/linked/harness.ts links outside the repository'));
  expect(marked('__importedThroughFolderLink')).toBeUndefined();
});

test('a symlink to a module inside the repository resolves, and its origin is the path project.yaml names', async () => {
  const { root, sailDir } = repo();
  write(root, 'shared/harness.ts', harnessModule());
  mkdirSync(join(sailDir, 'adapters'));
  symlinkSync(join(root, 'shared', 'harness.ts'), join(sailDir, 'adapters', 'link.ts'));
  const resolved = resolvedOrThrow(await resolve(sailDir, { harness: { use: './adapters/link.ts' } }));
  expect(resolved.ports.harness?.name).toBe('echo');
  expect(resolved.entries.harness).toEqual({ use: './adapters/link.ts', origin: 'repo:.sail/adapters/link.ts' });
});

test.each([
  [
    'capabilities() that throws',
    () => {
      throw new Error('no capabilities');
    },
    '',
  ],
  ['capabilities() that returns {}', () => ({}), 'structuredOutput'],
])(
  'a harness with %s is one issue saying its capabilities are not harness capabilities',
  async (_, capabilities, named) => {
    const { sailDir } = repo();
    const builtins = builtin('weak', 'harness', {
      create: () => stubAdapter('harness', (a) => (a.capabilities = capabilities)),
    });
    const result = await resolve(sailDir, { harness: { use: 'weak' } }, { builtins });
    expect(result).toEqual({
      issues: [
        {
          path: '/adapters/harness',
          message: expect.stringMatching(/^weak's capabilities\(\) are not harness capabilities: /),
        },
      ],
    });
    expect('issues' in result ? result.issues[0]?.message : '').toContain(named);
  },
);

test('the built-in fake harness, which reports no permissions, resolves, and a built-in that is not the fake is refused for the same', async () => {
  const { sailDir } = repo();
  const fake = resolvedOrThrow(await resolve(sailDir, {}));
  expect(fake.ports.harness?.capabilities().permissions).toBe(false);
  const builtins = builtin('open', 'harness', OPEN_HARNESS);
  const refused = await resolve(sailDir, { harness: { use: 'open' } }, { builtins });
  expect(refused).toEqual(issue('harness', 'open enforces no permissions, which only the built-in fake may'));
});

test('two ports broken at pass one give two issues in port order, and no definition is created', async () => {
  const { sailDir } = repo();
  const made: string[] = [];
  const result = await resolve(
    sailDir,
    { ticketSource: { use: 'nope1' }, codeHost: { use: 'counting' }, harness: { use: 'nope2' } },
    { builtins: builtin('counting', 'codeHost', counting('codeHost', made)) },
  );
  expect(result).toEqual({
    issues: [
      {
        path: '/adapters/ticketSource',
        message: "no built-in adapter 'nope1' fills ticketSource: the built-ins that do are fake",
      },
      {
        path: '/adapters/harness',
        message: "no built-in adapter 'nope2' fills harness: the built-ins that do are fake",
      },
    ],
  });
  expect(made).toEqual([]);
});

// TASK-005

/** Resolves with the harness `definition` as the built-in `only`, and a ticket-source `spy` that counts what is created. */
async function withHarness(definition: object, env: Env = {}, made: string[] = []) {
  const { sailDir } = repo();
  const builtins = {
    ...builtin('only', 'harness', definition),
    ...builtin('spy', 'ticketSource', counting('ticketSource', made, 'ticketSource')),
  };
  return resolve(sailDir, { harness: { use: 'only' }, ticketSource: { use: 'spy' } }, { builtins, env });
}

const harness = (members: object = {}) => ({ create: () => stubAdapter('harness'), ...members });

test.each<[string, Env]>([
  ['unset', {}],
  ['undefined', { A_TOKEN: undefined }],
  ['empty', { A_TOKEN: '' }],
])('a required variable that is %s is one issue, and no port is created', async (_, env) => {
  const made: string[] = [];
  const result = await withHarness(harness({ requires: () => ['A_TOKEN'] }), env, made);
  expect(result).toEqual(issue('harness', 'needs A_TOKEN, which is not set'));
  expect(made).toEqual([]);
});

test('every missing variable is reported, one issue each, in port order', async () => {
  const { sailDir } = repo();
  const builtins = {
    ...builtin('needy', 'ticketSource', { create: () => stubAdapter('ticketSource'), requires: () => ['T_KEY'] }),
    ...builtin('only', 'harness', harness({ requires: () => ['A_TOKEN', 'B_TOKEN'] })),
  };
  const result = await resolve(sailDir, { ticketSource: { use: 'needy' }, harness: { use: 'only' } }, { builtins });
  expect(result).toEqual({
    issues: [
      { path: '/adapters/ticketSource', message: 'needs T_KEY, which is not set' },
      { path: '/adapters/harness', message: 'needs A_TOKEN, which is not set' },
      { path: '/adapters/harness', message: 'needs B_TOKEN, which is not set' },
    ],
  });
});

test("requires gets the entry's options and the environment, so one adapter can need a key unless a flag is set", async () => {
  const seen: unknown[][] = [];
  const definition = harness({
    requires: (options: unknown, env: Env) => {
      seen.push([options, env]);
      return env.USE_CLOUD === undefined ? ['A_TOKEN'] : [];
    },
  });
  const { sailDir } = repo();
  const builtins = builtin('only', 'harness', definition);
  const env = { USE_CLOUD: '1' };
  const cloud = resolvedOrThrow(await resolve(sailDir, { harness: { use: 'only', region: 'eu' } }, { builtins, env }));
  expect(cloud.ports.harness?.name).toBe('stub');
  expect(seen).toEqual([[{ region: 'eu' }, env]]);
  expect(seen[0]?.[1]).toBe(env);
  const direct = await resolve(sailDir, { harness: { use: 'only' } }, { builtins });
  expect(direct).toEqual(issue('harness', 'needs A_TOKEN, which is not set'));
});

test('with the variable set it resolves, and its value is in no entry', async () => {
  const resolved = resolvedOrThrow(
    await withHarness(harness({ requires: () => ['A_TOKEN'] }), { A_TOKEN: 's3cr3t-token-value' }),
  );
  expect(resolved.ports.harness?.name).toBe('stub');
  expect(JSON.stringify(resolved.entries)).not.toContain('s3cr3t-token-value');
});

test.each<[string, () => unknown, string]>([
  [
    'throws',
    () => {
      throw new Error('kaput');
    },
    "only's requires() failed: kaput",
  ],
  ['returns a string', () => 'A_TOKEN', "only's requires() must return environment variable names"],
  ['returns an empty name', () => [''], "only's requires() must return environment variable names"],
])('a requires that %s is one issue', async (_, requires, message) => {
  expect(await withHarness(harness({ requires }))).toEqual(issue('harness', message));
});

test('a declared versions is recorded in the entry, and a header carrying it validates against sail.run.v1', async () => {
  const resolved = resolvedOrThrow(await withHarness(harness({ versions: () => ({ echo: '1.0.0' }) })));
  expect(resolved.entries.harness).toEqual({ use: 'only', origin: 'builtin', versions: { echo: '1.0.0' } });
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as RunHeader;
  expect(validateRunHeader({ ...golden, adapters: resolved.entries })).toEqual([]);
});

test.each<[string, object]>([
  ['declares none', harness()],
  ['declares an empty one', harness({ versions: () => ({}) })],
])('an adapter that %s has an entry with no versions key, beside one that does', async (_, plain) => {
  const { sailDir } = repo();
  const builtins = {
    ...builtin('plain', 'harness', plain),
    ...builtin('versioned', 'ticketSource', {
      create: () => stubAdapter('ticketSource'),
      versions: () => ({ lib: '2.0.0' }),
    }),
  };
  const resolved = resolvedOrThrow(
    await resolve(sailDir, { harness: { use: 'plain' }, ticketSource: { use: 'versioned' } }, { builtins }),
  );
  expect(resolved.entries.ticketSource.versions).toEqual({ lib: '2.0.0' });
  expect(Object.keys(resolved.entries.harness).sort()).toEqual(['origin', 'use']);
});

test.each<[string, () => unknown, string]>([
  [
    'throws',
    () => {
      throw new Error('oops');
    },
    "only's versions() failed: oops",
  ],
  ['returns a number as a version', () => ({ echo: 1 }), "only's versions() must return names and versions"],
  ['returns an array', () => ['1.0.0'], "only's versions() must return names and versions"],
  ['returns an empty name', () => ({ '': '1.0.0' }), "only's versions() must return names and versions"],
  ['returns a promise', async () => ({ echo: '1.0.0' }), "only's versions() must return names and versions"],
])('a versions that %s is one issue', async (_, versions, message) => {
  expect(await withHarness(harness({ versions }))).toEqual(issue('harness', message));
});

const rejects = async () => {
  throw new Error('probe failed');
};

test.each<[string, object, string]>([
  ['requires', harness({ requires: rejects }), "only's requires() must return environment variable names"],
  ['versions', harness({ versions: rejects }), "only's versions() must return names and versions"],
  [
    'capabilities',
    { create: () => stubAdapter('harness', (a) => (a.capabilities = rejects)) },
    "only's capabilities() are not harness capabilities: ",
  ],
])(
  'a %s that returns a rejected promise is one issue, and its rejection goes nowhere',
  async (_, definition, message) => {
    const unhandled: unknown[] = [];
    const listen = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listen);
    try {
      const result = await withHarness(definition);
      expect('issues' in result ? result.issues : result).toEqual([
        { path: '/adapters/harness', message: expect.stringMatching(new RegExp(`^${RegExp.escape(message)}`)) },
      ]);
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listen);
    }
  },
);

test("a version named 'issue' is recorded like any other", async () => {
  const resolved = resolvedOrThrow(await withHarness(harness({ versions: () => ({ issue: '4.2.0' }) })));
  expect(resolved.entries.harness).toEqual({ use: 'only', origin: 'builtin', versions: { issue: '4.2.0' } });
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as RunHeader;
  expect(validateRunHeader({ ...golden, adapters: resolved.entries })).toEqual([]);
});
