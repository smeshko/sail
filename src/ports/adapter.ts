// What makes an adapter, and what the core knows of each port without calling it: an adapter definition (DECISIONS D2),
// each port's operations and its capabilities schema (D9). The adapter registry checks an adapter it didn't write
// against these tables.
import type { z } from 'zod';
import type { Port } from '../engine/config';
import type { CodeHost } from './code-host';
import type { Harness } from './harness';
import type { ProviderOptions, TicketSource } from './ticket-source';
import { CodeHostCapabilities, HarnessCapabilities, TicketSourceCapabilities, WorkspaceCapabilities } from './types';
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

/**
 * A port's operation table: a tuple typed so that a name its interface lacks fails, and so does an interface method
 * the table leaves out (`name` aside). The registry checks an adapter against it.
 */
type Operations<A, Listed extends readonly (keyof A)[]> =
  Exclude<keyof A, 'name' | Listed[number]> extends never
    ? Listed
    : { missing: Exclude<keyof A, 'name' | Listed[number]> };

function operations<A>() {
  return <const Listed extends readonly Exclude<keyof A, 'name'>[]>(listed: Listed & Operations<A, Listed>): Listed =>
    listed;
}

/** Each port's method names, `capabilities` included and `name` left out. */
export const PORT_OPERATIONS = {
  ticketSource: operations<TicketSource>()([
    'parseKey',
    'get',
    'isDesignated',
    'listDesignated',
    'claim',
    'update',
    'comment',
    'capabilities',
  ]),
  codeHost: operations<CodeHost>()([
    'parseRef',
    'push',
    'openPullRequest',
    'listDesignated',
    'getPullRequest',
    'checks',
    'merge',
    'addLabel',
    'removeLabel',
    'comment',
    'capabilities',
  ]),
  harness: operations<Harness>()(['run', 'capabilities']),
  workspace: operations<WorkspacePort>()([
    'lease',
    'releaseLease',
    'create',
    'diff',
    'release',
    'sweep',
    'capabilities',
  ]),
} as const;

/** Each port's capabilities schema. */
export const PORT_CAPABILITIES: { readonly [P in Port]: z.ZodType } = {
  ticketSource: TicketSourceCapabilities,
  codeHost: CodeHostCapabilities,
  harness: HarnessCapabilities,
  workspace: WorkspaceCapabilities,
};
