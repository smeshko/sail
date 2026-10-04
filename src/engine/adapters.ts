// The adapter registry: turns the config's four adapter entries into four adapters. A built-in is found by name among
// the definitions it is handed, and the repository's own is imported by module path. Anything it can't resolve, create
// or recognise as its port is an issue at `/adapters/<port>`.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProviderEmit } from '../events/types';
import {
  type AdapterDefinition,
  type AdapterOptions,
  type Builtins,
  type Env,
  PORT_CAPABILITIES,
  PORT_OPERATIONS,
  type PortAdapters,
} from '../ports/adapter';
import { PORTS, type Port, type ProjectConfig } from './config';
import { registerSail } from './definitions';
import { origin } from './roster';
import { runsDir } from './run-dir';
import type { AdapterEntry } from './run-header';
import type { SchemaIssue } from './schemas';

export interface ResolveOptions {
  sailDir: string;
  config: ProjectConfig;
  builtins: Builtins;
  env: Env;
  emit?: ProviderEmit;
  now?: () => Date;
}

export interface ResolvedAdapters {
  ports: PortAdapters;
  entries: Record<Port, AdapterEntry>;
}

/** A definition found for a port, with where it came from. */
interface Found {
  definition: AdapterDefinition<unknown>;
  origin: string;
}

const isModulePath = (use: string) => use.startsWith('./') || use.startsWith('../');
/** Whether `path` is below `root`: the root itself is not. */
const isBelow = (root: string, path: string) => {
  const inside = relative(root, path);
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The definition a module default-exports, or why it isn't one. */
function asDefinition(value: unknown): AdapterDefinition<unknown> | undefined {
  if (!isObject(value) || typeof value.create !== 'function') return undefined;
  for (const optional of ['requires', 'versions']) {
    if (value[optional] !== undefined && typeof value[optional] !== 'function') return undefined;
  }
  return value as unknown as AdapterDefinition<unknown>;
}

/** Pass 1: the definition `use` names for `port`, or an issue. */
async function find(port: Port, use: string, options: ResolveOptions): Promise<Found | string> {
  if (!isModulePath(use)) {
    const definition = options.builtins[use]?.[port];
    if (definition) return { definition: definition as AdapterDefinition<unknown>, origin: 'builtin' };
    const fills = Object.keys(options.builtins)
      .filter((name) => options.builtins[name]?.[port])
      .sort();
    return `no built-in adapter '${use}' fills ${port}: the built-ins that do are ${fills.join(', ') || 'none'}`;
  }
  const root = dirname(options.sailDir);
  const path = resolve(options.sailDir, use);
  if (!isBelow(root, path)) return `'${use}' is outside the repository`;
  const at = origin(root, path).slice('repo:'.length);
  if (!existsSync(path)) return `${at} doesn't exist`;
  if (!statSync(path).isFile()) return `${at} is not a file`;
  // A symlink on the way can lead out of the repository, which the path alone doesn't show.
  const real = realpathSync(path);
  if (!isBelow(realpathSync(root), real)) return `${at} links outside the repository`;
  registerSail();
  let loaded: { default?: unknown };
  try {
    loaded = await import(real);
  } catch (error) {
    return `${at} failed to load: ${message(error)}`;
  }
  const definition = asDefinition(loaded.default);
  if (!definition) return `${at} default-exports no adapter definition: an object with create()`;
  return { definition, origin: origin(root, path) };
}

/** Pass 2: the issues for each environment variable `found` needs and `env` lacks. */
function preflight(use: string, found: Found, options: AdapterOptions, env: Env): string[] {
  if (found.definition.requires === undefined) return [];
  let names: unknown;
  try {
    names = found.definition.requires(options, env);
  } catch (error) {
    return [`${use}'s requires() failed: ${message(error)}`];
  }
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || name === '')) {
    return [`${use}'s requires() must return environment variable names`];
  }
  return names
    .filter((name: string) => env[name] === undefined || env[name] === '')
    .map((name) => `needs ${name}, which is not set`);
}

/** The versions `found` declares: none, or why its versions() can't be read. */
function declared(use: string, found: Found): Record<string, string> | { issue: string } {
  if (found.definition.versions === undefined) return {};
  let versions: unknown;
  try {
    versions = found.definition.versions();
  } catch (error) {
    return { issue: `${use}'s versions() failed: ${message(error)}` };
  }
  if (!isObject(versions) || Object.values(versions).some((version) => typeof version !== 'string')) {
    return { issue: `${use}'s versions() must return names and versions` };
  }
  return versions as Record<string, string>;
}

/** Pass 3: creates the adapter and checks it is its port's, or gives the issue. */
async function build(
  port: Port,
  use: string,
  found: Found,
  options: AdapterOptions,
  resolved: ResolveOptions,
): Promise<{ adapter: unknown } | { issue: string }> {
  const fail = (text: string) => ({ issue: text });
  let adapter: unknown;
  try {
    adapter = await found.definition.create(options, {
      root: dirname(resolved.sailDir),
      sailDir: resolved.sailDir,
      runsDir: runsDir(resolved.sailDir),
      env: resolved.env,
      ...(resolved.emit === undefined ? {} : { emit: resolved.emit }),
      ...(resolved.now === undefined ? {} : { now: resolved.now }),
    });
  } catch (error) {
    return fail(`${use} could not be created: ${message(error)}`);
  }
  if (!isObject(adapter) || typeof adapter.name !== 'string' || adapter.name === '') {
    return fail(`${use} is not an adapter: it has no name`);
  }
  const missing = PORT_OPERATIONS[port].filter((name) => typeof adapter[name] !== 'function');
  if (missing.length > 0)
    return fail(`${use} doesn't implement ${port}: ${missing.map((name) => `${name}()`).join(', ')} is missing`);
  let capabilities: unknown;
  try {
    capabilities = (adapter.capabilities as () => unknown)();
  } catch (error) {
    return fail(`${use}'s capabilities() are not ${port} capabilities: ${message(error)}`);
  }
  const parsed = PORT_CAPABILITIES[port].safeParse(capabilities);
  if (!parsed.success) return fail(`${use}'s capabilities() are not ${port} capabilities: ${parsed.error.message}`);
  const permissions = isObject(parsed.data) ? parsed.data.permissions : undefined;
  if (port === 'harness' && permissions === false && !(use === 'fake' && found.origin === 'builtin')) {
    return fail(`${use} enforces no permissions, which only the built-in fake may`);
  }
  return { adapter };
}

/** Resolves, preflights and creates the four adapters, or gives every issue the first failing pass found. */
export async function resolveAdapters(options: ResolveOptions): Promise<ResolvedAdapters | { issues: SchemaIssue[] }> {
  const issues: SchemaIssue[] = [];
  const issue = (port: Port, text: string) => issues.push({ path: `/adapters/${port}`, message: text });
  const optionsOf = ({ use: _use, ...rest }: ProjectConfig['adapters'][Port]): AdapterOptions => rest;

  const found = {} as Record<Port, Found>;
  for (const port of PORTS) {
    const result = await find(port, options.config.adapters[port].use, options);
    if (typeof result === 'string') issue(port, result);
    else found[port] = result;
  }
  if (issues.length > 0) return { issues };

  for (const port of PORTS) {
    const { use } = options.config.adapters[port];
    for (const text of preflight(use, found[port], optionsOf(options.config.adapters[port]), options.env))
      issue(port, text);
  }
  if (issues.length > 0) return { issues };

  const ports = {} as Record<Port, unknown>;
  const entries = {} as Record<Port, AdapterEntry>;
  for (const port of PORTS) {
    const { use } = options.config.adapters[port];
    const versions = declared(use, found[port]);
    if ('issue' in versions) {
      issue(port, versions.issue);
      continue;
    }
    const built = await build(port, use, found[port], optionsOf(options.config.adapters[port]), options);
    if ('issue' in built) {
      issue(port, built.issue);
      continue;
    }
    ports[port] = built.adapter;
    entries[port] = {
      use,
      origin: found[port].origin,
      ...(Object.keys(versions).length === 0 ? {} : { versions }),
    };
  }
  if (issues.length > 0) return { issues };
  return { ports: ports as unknown as PortAdapters, entries };
}
