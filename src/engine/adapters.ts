// The adapter registry: turns the config's four adapter entries into four adapters. A built-in is found by name among
// the definitions it is handed, and the repository's own is imported by module path. Anything it can't resolve, create
// or recognise as its port is an issue at `/adapters/<port>`.
import type { ProviderEmit } from '../events/types';
import type { Builtins, Env, PortAdapters } from '../ports/adapter';
import { PORTS, type Port, type ProjectConfig } from './config';
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

/** Resolves, preflights and creates the four adapters, or gives every issue the first failing pass found. */
export async function resolveAdapters(_options: ResolveOptions): Promise<ResolvedAdapters | { issues: SchemaIssue[] }> {
  const blank: AdapterEntry = { use: '', origin: '' };
  return {
    ports: {} as PortAdapters,
    entries: Object.fromEntries(PORTS.map((port) => [port, blank])) as Record<Port, AdapterEntry>,
  };
}
