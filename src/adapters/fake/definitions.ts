// The fakes as adapter definitions: each reads its options from `project.yaml` and is created from them (DECISIONS D7).
// A fake reads nothing when it is created, so a repository without seed files still resolves.
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Port } from '../../engine/config';
import type { AdapterContext, AdapterDefinition, AdapterOptions, Env, PortAdapters } from '../../ports/adapter';
import { createFakeCodeHost } from './code-host';
import { createFakeHarness } from './harness';
import { createPlaybackHarness } from './playback';
import { checkFakePickUp, createFakeTicketSource } from './ticket-source';
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
      const shape = {
        seed: z.string().optional(),
        pickUp: z
          .array(z.string().min(1))
          .min(1)
          .refine((names) => new Set(names).size === names.length, 'names a state twice')
          .optional(),
      };
      const { seed, pickUp } = parse('ticketSource', shape, options);
      if (pickUp !== undefined) {
        try {
          checkFakePickUp(pickUp);
        } catch (error) {
          throw new Error(`fake ticketSource: ${(error as Error).message}`);
        }
      }
      return createFakeTicketSource({
        ...provider(context),
        ...(pickUp === undefined ? {} : { pickUp }),
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
      const shape = {
        script: z.string().optional(),
        playback: z.string().optional(),
        onPromptMismatch: z.enum(['fail', 'warn']).optional(),
      };
      const { script, playback, onPromptMismatch } = parse('harness', shape, options);
      if (playback !== undefined && script !== undefined) {
        throw new Error('fake harness: option playback: can not be combined with option script');
      }
      if (playback === undefined && onPromptMismatch !== undefined) {
        throw new Error('fake harness: option onPromptMismatch: needs option playback');
      }
      if (playback !== undefined) {
        return createPlaybackHarness({
          dir: resolve(context.sailDir, playback),
          ...(onPromptMismatch === undefined ? {} : { onPromptMismatch }),
        });
      }
      return createFakeHarness({ script: resolve(context.sailDir, script ?? 'fake/harness.json') });
    },
  },
  workspace: {
    create(options, context) {
      const shape = {
        repo: z.string().optional(),
        remote: z.string().min(1).optional(),
        defaultBranch: z.string().min(1).optional(),
      };
      const { repo, remote, defaultBranch } = parse('workspace', shape, options);
      return createFakeWorkspace({
        ...provider(context),
        repo: repo === undefined ? context.root : resolve(context.sailDir, repo),
        ...(remote === undefined ? {} : { remote }),
        ...(defaultBranch === undefined ? {} : { defaultBranch }),
        // Beside the fake ticket and pull request state, so a run on the fakes holds no lease machine-wide (D5).
        leasesDir: resolve(context.runsDir, 'fake/leases'),
        env: definedEnv(context.env),
      });
    },
  },
};
