// The permission engine's entry point. `decide` is the only function the harness adapters call.
import type { Permissions } from '../../sdk/steps';
import type { Decision, Roots, Rule, ToolCall } from './types';

export type { Decision, Denial, Roots, Rule, ToolCall, ToolKind } from './types';
export { isDenial, Refusal, RULES } from './types';

/** Decides one tool call against a step's permissions. Denials are returned, never thrown. */
export function decide(_call: ToolCall, _policy: Permissions, _roots: Roots): Decision {
  // A stub denial names no rule, so no table row that expects a rule passes against it.
  return { deny: true, rule: 'stub' as Rule, reason: 'stub' };
}
