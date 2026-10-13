// The credential preflight for the claude-code adapter. This is the one place the open question about the local Claude Code
// login lives: a session with the login and no key is refused here today, and the rule changes here and nowhere else.
import type { AdapterOptions, Env } from '../../ports/adapter';

/** The cloud provider flags. When one is set, the provider holds the credentials and no API key is needed. */
const CLOUD_FLAGS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'] as const;

/** The environment variables a session needs, given its options and the environment. */
export function requires(_options: AdapterOptions, env: Env): string[] {
  const cloud = CLOUD_FLAGS.some((name) => (env[name] ?? '') !== '');
  return cloud ? [] : ['ANTHROPIC_API_KEY'];
}
