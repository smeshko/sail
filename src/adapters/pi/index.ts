// The built-in pi adapter: the Harness over pi's coding-agent SDK, whose providers include non-Anthropic and local
// models. Preflight needs the key of each provider the `provider/model` ids the config routes to it use. It takes one
// option, `provider`, whose key preflight needs as well.
import { z } from 'zod';
import type { AdapterDefinition, AdapterOptions, Env } from '../../ports/adapter';
import type { Harness } from '../../ports/harness';
import { createPiHarness } from './harness';
import { keyNames } from './providers';

export { createPiHarness } from './harness';

/** The SDK's version, which `package.json` pins exactly: the SDK exports no way to read it. */
export const PI_VERSION = '1.4.0';

const Options = z.strictObject({ provider: z.string().min(1).optional() });

/**
 * The environment variables the providers need: one of each one's key names, and nothing for a keyless provider. The
 * providers are the `provider` option's and those of `models`, the model ids routed to this harness.
 */
export function requires(options: AdapterOptions, _env: Env, models: readonly string[] = []): (string | string[])[] {
  const option = typeof options.provider === 'string' && options.provider !== '' ? [options.provider] : [];
  const routed = models.flatMap((model) => (model.indexOf('/') > 0 ? [model.slice(0, model.indexOf('/'))] : []));
  return [...new Set([...option, ...routed])].flatMap((provider): (string | string[])[] => {
    const names = keyNames(provider);
    if (names.length === 0) return [];
    return names.length === 1 ? [...names] : [[...names]];
  });
}

export const piAdapters: { harness: AdapterDefinition<Harness> } = {
  harness: {
    requires,
    versions: () => ({ '@earendil-works/pi-coding-agent': PI_VERSION }),
    create(options, context) {
      const parsed = Options.safeParse(options);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const option = issue?.code === 'unrecognized_keys' ? issue.keys.join(', ') : issue?.path.join('.');
        throw new Error(`pi harness: option ${option}: ${issue?.message}`);
      }
      return createPiHarness({ env: context.env });
    },
  },
};
