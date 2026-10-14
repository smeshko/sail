// decide(): every tool call's verdict from its step's permissions alone. Synchronous, so the harness can ask it inline
// before each call, and it never throws: what it can't decide it denies.
// STUB (tdd-plan): every call is refused. TASK-008 writes the dispatch.
import type { DecideContext, Decision, Permissions, ToolCall } from './types';

export type { DecideContext, Decision, DenialRule, ToolCall, ToolKind } from './types';

/** The verdict for one tool call: allowed, or denied with its rule and the reason. */
export function decide(_call: ToolCall, _permissions: Permissions, _ctx: DecideContext): Decision {
  return { allow: false, rule: 'tools', reason: 'stub' };
}
