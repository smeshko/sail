// The built-in pi adapter: the Harness over pi's coding-agent SDK, whose providers include non-Anthropic and local
// models. It takes one option, `provider` (default `anthropic`), which preflight needs: `requires()` can't see the
// `models:` it is run with, and names the variable that provider's credential is read from.
import { z } from 'zod';
import type { AdapterDefinition, AdapterOptions, Env } from '../../ports/adapter';
import type { Harness } from '../../ports/harness';
import { createPiHarness } from './harness';
import { keyNames } from './providers';

export { createPiHarness } from './harness';

/** The SDK's version, which `package.json` pins exactly: the SDK exports no way to read it. */
export const PI_VERSION = '0.73.1';

const Options = z.strictObject({ provider: z.string().min(1).optional() });

/** The environment variables the provider needs: one of its key names, and nothing for a keyless provider. */
export function requires(options: AdapterOptions, _env: Env): (string | string[])[] {
  const provider = typeof options.provider === 'string' && options.provider !== '' ? options.provider : 'anthropic';
  const names = keyNames(provider);
  if (names.length === 0) return [];
  return names.length === 1 ? [...names] : [[...names]];
}

export const piAdapters: { harness: AdapterDefinition<Harness> } = {
  harness: {
    requires,
    versions: () => ({ '@mariozechner/pi-coding-agent': PI_VERSION }),
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
