// The ports a run's stop and clean need in a registered clone, resolved from that clone's `project.yaml` as `sail stop`
// and `sail clean` resolve them: the Workspace port at once, and the code host only when asked for, so a clean of a run
// with no branch on the remote needs no code host credentials. Resolving can fail on the config or a credential, and
// then the answer is the formatted issues.
import { BUILTINS } from '../adapters/index';
import { type ResolvedAdapters, resolveAdapters } from '../engine/adapters';
import { readConfig } from '../engine/config';
import { formatIssue } from '../engine/schemas';
import type { CodeHost } from '../ports/code-host';
import type { RegistryEntry } from '../watch/registry';

export interface ClonePorts {
  adapters: ResolvedAdapters<'workspace'>;
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
  let host: Promise<CodeHost | { refused: string }> | undefined;
  const codeHost = (): Promise<CodeHost | { refused: string }> => {
    host ??= (async () => {
      const resolved = await resolveAdapters({
        sailDir,
        config,
        builtins: BUILTINS,
        env: environment,
        ports: ['codeHost'],
      });
      if ('issues' in resolved) return { refused: resolved.issues.map(formatIssue).join('; ') };
      return resolved.ports.codeHost;
    })();
    return host;
  };
  return { adapters, codeHost };
}
