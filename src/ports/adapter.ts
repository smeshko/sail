// What makes an adapter, and what the core knows of each port without calling it: an adapter definition (DECISIONS D2),
// each port's operations and its capabilities schema (D9). The adapter registry checks an adapter it didn't write
// against these tables.
import { z } from 'zod';
import type { Port } from '../engine/config';
import type { CodeHost } from './code-host';
import type { Harness } from './harness';
import type { ProviderOptions, TicketSource } from './ticket-source';
import type { WorkspacePort } from './workspace';

export type Env = Readonly<Record<string, string | undefined>>;

/** An adapter's `project.yaml` entry without `use`. */
export type AdapterOptions = Readonly<Record<string, unknown>>;

/** What `create` receives beside the adapter's options. */
export interface AdapterContext extends ProviderOptions {
  /** The repository: the directory that holds `.sail/`. */
  readonly root: string;
  readonly sailDir: string;
  readonly runsDir: string;
  readonly env: Env;
}

export interface AdapterDefinition<A> {
  /** The environment variables this adapter needs, given its options and the environment. */
  requires?(options: AdapterOptions, env: Env): readonly string[];
  versions?(): Readonly<Record<string, string>>;
  create(options: AdapterOptions, context: AdapterContext): A | Promise<A>;
}

export interface PortAdapters {
  ticketSource: TicketSource;
  codeHost: CodeHost;
  harness: Harness;
  workspace: WorkspacePort;
}

/** The built-in adapters by name, each with one definition per port it fills. */
export type Builtins = Readonly<Record<string, { readonly [P in Port]?: AdapterDefinition<PortAdapters[P]> }>>;

/** Each port's method names, `capabilities` included and `name` left out. */
export const PORT_OPERATIONS: { readonly [P in Port]: readonly Exclude<keyof PortAdapters[P], 'name'>[] } = {
  ticketSource: [],
  codeHost: [],
  harness: [],
  workspace: [],
};

/** Each port's capabilities schema. */
export const PORT_CAPABILITIES: { readonly [P in Port]: z.ZodType } = {
  ticketSource: z.never(),
  codeHost: z.never(),
  harness: z.never(),
  workspace: z.never(),
};
