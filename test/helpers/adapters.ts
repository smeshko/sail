// fakeAdapters(): the four adapters a repository's `.sail/project.yaml` names, resolved with the built-ins, for a test
// that opens or resumes a run. A run is handed its adapters, so each call site resolves them itself, as `sail run` does.
import { BUILTINS } from '../../src/adapters/index';
import { type ResolvedAdapters, resolveAdapters } from '../../src/engine/adapters';
import type { Port } from '../../src/engine/config';
import { readConfig } from '../../src/engine/config';
import { findSailDir } from '../../src/engine/sail-dir';
import { formatIssue } from '../../src/engine/schemas';
import type { Env } from '../../src/ports/adapter';

/** The adapters of the `.sail/` found from `cwd`, whose `project.yaml` must be valid and name only built-ins. It throws on an issue. */
export async function fakeAdapters(cwd: string, env: Env = {}): Promise<ResolvedAdapters> {
  const found = findSailDir(cwd);
  if ('refused' in found) throw new Error(found.refused);
  const sailDir = found.dir;
  const config = readConfig(sailDir);
  if ('issues' in config) throw new Error(`${sailDir}/project.yaml: ${config.issues.map(formatIssue).join('; ')}`);
  const resolved = await resolveAdapters({ sailDir, config, builtins: BUILTINS, env });
  if ('issues' in resolved) throw new Error(`adapters: ${resolved.issues.map(formatIssue).join('; ')}`);
  return resolved;
}

/** Each port's operations as the design names them: its methods, `capabilities` included, `name` left out. */
export const OPERATIONS: Record<Port, string[]> = {
  ticketSource: ['capabilities', 'claim', 'comment', 'get', 'isDesignated', 'listDesignated', 'parseKey', 'update'],
  codeHost: [
    'addLabel',
    'capabilities',
    'checks',
    'comment',
    'getPullRequest',
    'listDesignated',
    'merge',
    'openPullRequest',
    'parseRef',
    'push',
    'removeLabel',
  ],
  harness: ['capabilities', 'run'],
  workspace: ['capabilities', 'create', 'diff', 'lease', 'release', 'releaseLease', 'sweep'],
};

/** Capabilities each port's schema accepts. */
export const CAPABILITIES: Record<Port, unknown> = {
  ticketSource: { comments: true, links: true, attachments: true, moves: ['in-progress'] },
  codeHost: { checks: true, labels: true, drafts: true, mergeMethods: ['merge'] },
  harness: { structuredOutput: true, permissions: true, usage: true, abort: true, budgets: [] },
  workspace: { keep: true, sweep: true },
};

/** An adapter for `port` with every operation a function that does nothing, `change`d by the test. */
export function stubAdapter(port: Port, change: (adapter: Record<string, unknown>) => void = () => undefined) {
  const adapter: Record<string, unknown> = { name: 'stub', capabilities: () => CAPABILITIES[port] };
  for (const operation of OPERATIONS[port]) if (operation !== 'capabilities') adapter[operation] = () => undefined;
  change(adapter);
  return adapter;
}
