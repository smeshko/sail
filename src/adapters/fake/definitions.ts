// The fakes as adapter definitions: each reads its options from `project.yaml` and is created from them (DECISIONS D7).
// A fake reads nothing when it is created, so a repository without seed files still resolves.
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Port } from '../../engine/config';
import type { AdapterContext, AdapterDefinition, AdapterOptions, Env, PortAdapters } from '../../ports/adapter';
import { createFakeCodeHost } from './code-host';
import { createFakeHarness } from './harness';
import { createFakeTicketSource } from './ticket-source';
import { createFakeWorkspace } from './workspace';

/** Parses `options` with a strict object, or throws naming the offending option. */
function parse<S extends z.ZodRawShape>(port: Port, shape: S, options: AdapterOptions): z.infer<z.ZodObject<S>> {
  const parsed = z.strictObject(shape).safeParse(options);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const option = issue?.code === 'unrecognized_keys' ? issue.keys.join(', ') : issue?.path.join('.');
  throw new Error(`fake ${port}: option ${option}: ${issue?.message}`);
}

/** The environment without its unset variables, for the git a fake spawns. */
function definedEnv(env: Env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

const provider = (context: AdapterContext) => ({
  ...(context.emit === undefined ? {} : { emit: context.emit }),
  ...(context.now === undefined ? {} : { now: context.now }),
});

export const fakeAdapters: { [P in Port]: AdapterDefinition<PortAdapters[P]> } = {
  ticketSource: {
    create(options, context) {
      const { seed } = parse('ticketSource', { seed: z.string().optional() }, options);
      return createFakeTicketSource({
        ...provider(context),
        seed: resolve(context.sailDir, seed ?? 'fake/tickets.json'),
        state: resolve(context.runsDir, 'fake/tickets.json'),
      });
    },
  },
  codeHost: {
    create(options, context) {
      const { seed } = parse('codeHost', { seed: z.string().optional() }, options);
      return createFakeCodeHost({
        ...provider(context),
        seed: resolve(context.sailDir, seed ?? 'fake/prs.json'),
        state: resolve(context.runsDir, 'fake/prs.json'),
        env: definedEnv(context.env),
      });
    },
  },
  harness: {
    create(options, context) {
      const { script } = parse('harness', { script: z.string().optional() }, options);
      return createFakeHarness({ script: resolve(context.sailDir, script ?? 'fake/harness.json') });
    },
  },
  workspace: {
    create(options, context) {
      const { repo } = parse('workspace', { repo: z.string().optional() }, options);
      return createFakeWorkspace({
        ...provider(context),
        repo: repo === undefined ? context.root : resolve(context.sailDir, repo),
        env: definedEnv(context.env),
      });
    },
  },
};
