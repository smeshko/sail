// The built-in claude-code adapter: the Harness over the Agent SDK. It takes no options, and its preflight names the
// credentials its provider needs (D9): an Anthropic API key, or a cloud region and project on Bedrock or Vertex.
//
// STUB (TASK-008): signatures only, each returning a wrong value. It is not in BUILTINS yet.
import type { AdapterDefinition, Env } from '../../ports/adapter';
import type { Harness } from '../../ports/harness';
import { createClaudeCodeHarness } from './harness';

export { createClaudeCodeHarness } from './harness';

/** The Agent SDK's version, which `package.json` pins: the SDK exports no way to read it. */
export const SDK_VERSION: string = '';

/** The environment variables the session's provider needs. */
export function requires(_env: Env): string[] {
  return [];
}

export const claudeCodeAdapters: { harness: AdapterDefinition<Harness> } = {
  harness: {
    requires: (_options, env) => requires(env),
    versions: () => ({}),
    create: (_options, context) => createClaudeCodeHarness({ env: context.env }),
  },
};
