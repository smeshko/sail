// fakeAdapters(): the four adapters a repository's `.sail/project.yaml` names, resolved with the built-ins, for a test
// that opens or resumes a run. A run is handed its adapters, so each call site resolves them itself, as the CLI does.
import { BUILTINS } from '../../src/adapters/index';
import { type ResolvedAdapters, resolveAdapters } from '../../src/engine/adapters';
import type { Port } from '../../src/engine/config';
import { readConfig } from '../../src/engine/config';
import { findSailDir } from '../../src/engine/sail-dir';
import { formatIssue } from '../../src/engine/schemas';
import type { Builtins, Env } from '../../src/ports/adapter';

/**
 * The adapters of the `.sail/` found from `cwd`, whose `project.yaml` must be valid and name only built-ins. It throws
 * on an issue. `options.now` is the clock the adapters read: a run that must be reproduced hands them its own.
 */
export async function fakeAdapters(
  cwd: string,
  env: Env = {},
  options: { now?: () => Date; builtins?: Builtins } = {},
): Promise<ResolvedAdapters> {
  const found = findSailDir(cwd);
  if ('refused' in found) throw new Error(found.refused);
  const sailDir = found.dir;
  const config = readConfig(sailDir);
  if ('issues' in config) throw new Error(`${sailDir}/project.yaml: ${config.issues.map(formatIssue).join('; ')}`);
  const resolved = await resolveAdapters({ sailDir, config, ...options, builtins: options.builtins ?? BUILTINS, env });
  if ('issues' in resolved) throw new Error(`adapters: ${resolved.issues.map(formatIssue).join('; ')}`);
  return resolved;
}

/**
 * The built-ins plus a `spy` adapter whose harness is the fake one under another name, pushing each call key it is
 * asked to run into `keys`.
 */
export function spyBuiltins(keys: string[]): Builtins {
  const fake = BUILTINS.fake?.harness;
  if (fake === undefined) throw new Error('the built-ins have no fake harness');
  return {
    ...BUILTINS,
    spy: {
      harness: {
        async create(options, context) {
          const inner = await fake.create(options, context);
          return {
            name: 'spy',
            capabilities: () => ({ ...inner.capabilities(), permissions: true }),
            run: (request) => {
              keys.push(request.key);
              return inner.run(request);
            },
          };
        },
      },
    },
  };
}

/** Each port's operations as the design names them: its methods, `capabilities` included, `name` left out. */
export const OPERATIONS: Record<Port, string[]> = {
  ticketSource: [
    'addLabel',
    'attach',
    'canPickUp',
    'capabilities',
    'claim',
    'comment',
    'create',
    'edit',
    'get',
    'isDesignated',
    'list',
    'listDesignated',
    'parseKey',
    'relate',
    'removeLabel',
    'update',
  ],
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
  workspace: [
    'capabilities',
    'create',
    'diff',
    'holder',
    'lease',
    'release',
    'releaseLease',
    'reopen',
    'repository',
    'sweep',
  ],
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
