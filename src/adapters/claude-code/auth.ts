// The credential preflight for the claude-code adapter. STUB (TASK-004). This is the one place the open question about
// the local Claude Code login lives: it changes here and nowhere else.
import type { AdapterOptions, Env } from '../../ports/adapter';

/** The environment variables a session needs, given its options and the environment. Stub: a name no session needs. */
export function requires(_options: AdapterOptions, _env: Env): string[] {
  return ['STUB_NOT_A_VARIABLE'];
}
