// STUB (harness-guardrails TASK-002): the final types, and a gate that decides nothing and denies, unsaid, what reaches it.
import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { DecideContext } from '../../engine/permissions';
import type { Permissions } from '../../engine/permissions/types';
import type { Denial } from './tool-call';

export interface GateOptions {
  readonly permissions: Permissions;
  readonly ctx: DecideContext;
  /** Told of every denial, with the call's id. */
  readonly onDenied?: (toolUseId: string, denial: Denial) => void;
}

export interface Gate {
  readonly preToolUse: HookCallback;
  readonly canUseTool: CanUseTool;
}

export function createGate(_options: GateOptions): Gate {
  return {
    preToolUse: async () => ({}),
    canUseTool: async () => ({ behavior: 'deny', message: '' }),
  };
}
