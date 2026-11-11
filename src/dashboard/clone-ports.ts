// The ports a run's stop and clean need in a registered clone, resolved from that clone's `project.yaml` as `sail stop`
// and `sail clean` resolve them: the Workspace port at once, and the code host and ticket source only when asked for, so
// a clean of a run with no branch on the remote, or of no ticket, needs no credentials. Resolving can fail on the config or a credential, and
// then the answer is the formatted issues.
import { BUILTINS } from '../adapters/index';
import { type ResolvedAdapters, resolveAdapters } from '../engine/adapters';
import { type ProjectConfig, readConfig } from '../engine/config';
import { formatIssue } from '../engine/schemas';
import type { CodeHost } from '../ports/code-host';
import type { TicketSource } from '../ports/ticket-source';
import { lazyPorts } from '../watch/clean-runs';
import type { RegistryEntry } from '../watch/registry';

export interface ClonePorts {
  adapters: ResolvedAdapters<'workspace'>;
  /** The clone's config, which a queue command is checked against. */
  config: ProjectConfig;
  /** The clone's ticket source, resolved on the first call. */
  ticketSource: () => Promise<TicketSource | { refused: string }>;
  /** The clone's code host, resolved on the first call. */
  codeHost: () => Promise<CodeHost | { refused: string }>;
}

export type ResolveClonePorts = (entry: RegistryEntry) => Promise<ClonePorts | { refused: string }>;

export async function clonePorts(
  entry: RegistryEntry,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ClonePorts | { refused: string }> {
  const { sailDir } = entry;
  const config = readConfig(sailDir);
  if ('issues' in config) return { refused: config.issues.map(formatIssue).join('; ') };
  const environment = Object.fromEntries(
    Object.entries(env).filter((each): each is [string, string] => each[1] !== undefined),
  );
  const adapters = await resolveAdapters({
    sailDir,
    config,
    builtins: BUILTINS,
    env: environment,
    ports: ['workspace'],
  });
  if ('issues' in adapters) return { refused: adapters.issues.map(formatIssue).join('; ') };
  const { codeHost, ticketSource } = lazyPorts({ sailDir, config, env: environment });
  return { adapters, config, codeHost, ticketSource };
}
