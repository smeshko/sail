// The credential preflight for the claude-code adapter. This is the one place the open question about the local Claude Code
// login lives: a session with the login and no key is refused here today, and the rule changes here and nowhere else.
import type { AdapterOptions, Env } from '../../ports/adapter';

/** The cloud providers a session can run on, by the flag that selects each. */
const CLOUD_FLAGS = { CLAUDE_CODE_USE_BEDROCK: 'bedrock', CLAUDE_CODE_USE_VERTEX: 'vertex' } as const;

/** The cloud provider the environment selects, or nothing for the direct API. Its cost is an estimate in session.log. */
export function cloudProviderOf(env: Env): 'bedrock' | 'vertex' | undefined {
  const selected = Object.entries(CLOUD_FLAGS).find(([name]) => (env[name] ?? '') !== '');
  return selected?.[1];
}

/** The environment variables a session needs, given its options and the environment. */
export function requires(_options: AdapterOptions, env: Env): string[] {
  return cloudProviderOf(env) === undefined ? ['ANTHROPIC_API_KEY'] : [];
}
