// The built-in claude-code adapter: the Harness over the Agent SDK. It takes no options, and its preflight names the
// credentials its provider needs (D9): an Anthropic API key, or a cloud region and project on Bedrock or Vertex.
import { z } from 'zod';
import type { AdapterDefinition, Env } from '../../ports/adapter';
import type { Harness } from '../../ports/harness';
import { createClaudeCodeHarness } from './harness';

export { createClaudeCodeHarness } from './harness';

/** The Agent SDK's version, which `package.json` pins: the SDK exports no way to read it. */
export const SDK_VERSION = '0.3.282';

/** Whether a switch such as `CLAUDE_CODE_USE_BEDROCK` is on. */
const on = (value: string | undefined): boolean => value !== undefined && value !== '' && value !== '0';

/** The environment variables the session's provider needs. */
export function requires(env: Env): string[] {
  if (on(env.CLAUDE_CODE_USE_BEDROCK)) return ['AWS_REGION'];
  if (on(env.CLAUDE_CODE_USE_VERTEX)) return ['CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID'];
  return ['ANTHROPIC_API_KEY'];
}

export const claudeCodeAdapters: { harness: AdapterDefinition<Harness> } = {
  harness: {
    requires: (_options, env) => requires(env),
    versions: () => ({ '@anthropic-ai/claude-agent-sdk': SDK_VERSION }),
    create(options, context) {
      const parsed = z.strictObject({}).safeParse(options);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const option = issue?.code === 'unrecognized_keys' ? issue.keys.join(', ') : issue?.path.join('.');
        throw new Error(`claude-code harness: option ${option}: ${issue?.message}`);
      }
      return createClaudeCodeHarness({ env: context.env });
    },
  },
};
