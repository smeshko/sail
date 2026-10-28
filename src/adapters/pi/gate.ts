// The gate every tool call of a pi session passes before it runs. A sail-owned extension's `tool_call` hook sees each
// call, maps it to sail's ToolCall and answers with decide()'s verdict: undefined to let it run, or a block with the
// reason, which the model reads. Each denial is reported with its rule, the step's permissions under it and the reason.
// A grep or find of a folder reads every file below it, so it also needs a read glob that covers them all.
import { type DecideContext, type DenialRule, decide } from '../../engine/permissions';
import type { Permissions } from '../../engine/permissions/types';
import { ruleOf, uncoveredSearch } from '../claude-code/gate';
import type { Denial } from '../claude-code/tool-call';
import { SUBMIT_TOOL, toToolCall } from './tool-call';

/** The part of pi's `tool_call` event the gate reads. */
export interface PiToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface Block {
  readonly block: true;
  readonly reason: string;
}

export interface GateOptions {
  readonly permissions: Permissions;
  readonly ctx: DecideContext;
  /** Told of every denial, with the call's id. */
  readonly onDenied?: (toolCallId: string, denial: Denial) => void;
}

export interface Gate {
  toolCall(event: PiToolCall): Block | undefined;
}

/** The part of pi's extension API the gate registers on. */
export interface ExtensionHost {
  on(event: 'tool_call', handler: (event: PiToolCall) => Block | undefined): void;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createGate(options: GateOptions): Gate {
  const { permissions, ctx } = options;
  // Bun's realpathSync('') is the process's own directory, so an empty root would place sail's cwd in the call's
  // directories: a gate without all three roots decides nothing, and blocks.
  const rootless = [ctx.worktree, ctx.stageIn, ctx.stageOut].some((root) => root.trim() === '');

  const denied = (toolCallId: string, tool: string, rule: DenialRule, reason: string): void => {
    try {
      options.onDenied?.(toolCallId, { tool, rule, permissions: { [rule]: permissions[rule] ?? [] }, reason });
    } catch {
      // The verdict stands.
    }
  };

  const verdict = (tool: string, input: unknown): { rule: DenialRule; reason: string } | undefined => {
    try {
      const mapped = toToolCall(tool, input, ctx.worktree);
      if ('unchecked' in mapped) return { rule: ruleOf(mapped.kind), reason: `can't be checked: ${mapped.unchecked}` };
      if (rootless) {
        return {
          rule: ruleOf(mapped.call.kind),
          reason: `${tool}: can't be decided: the call's directories aren't all set`,
        };
      }
      const decided = decide(mapped.call, permissions, ctx);
      if (!decided.allow) return { rule: decided.rule, reason: decided.reason };
      const searches = tool === 'grep' || tool === 'find';
      const uncovered = searches ? uncoveredSearch(mapped.call, permissions, ctx) : undefined;
      return uncovered === undefined ? undefined : { rule: 'read', reason: uncovered };
    } catch (error) {
      return { rule: 'tools', reason: `${tool}: can't be decided: ${messageOf(error)}` };
    }
  };

  return {
    toolCall({ toolCallId, toolName, input }) {
      if (toolName === SUBMIT_TOOL) return undefined;
      const denial = verdict(toolName, input);
      if (denial === undefined) return undefined;
      denied(toolCallId, toolName, denial.rule, denial.reason);
      return { block: true, reason: denial.reason };
    },
  };
}

/** The extension factory that puts the gate on every tool call of a session. */
export function gateExtension(gate: Gate): (pi: ExtensionHost) => void {
  return (pi) => pi.on('tool_call', (event) => gate.toolCall(event));
}
