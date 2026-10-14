// decide(): every tool call's verdict from its step's permissions alone. Synchronous, so the harness can ask it inline
// before each call, and it never throws: what it can't decide it denies.
import { decideCommand } from './commands';
import { checkRead, checkWrite } from './paths';
import {
  allow,
  type DecideContext,
  type Decision,
  type DenialRule,
  deny,
  type Permissions,
  type ToolCall,
} from './types';

export type { DecideContext, Decision, DenialRule, ToolCall, ToolKind } from './types';

/** The rule a call of `kind` is denied under. */
function ruleOf(kind: string): DenialRule {
  if (kind === 'read') return 'read';
  if (kind === 'write' || kind === 'edit') return 'write';
  if (kind === 'execute') return 'commands';
  return 'tools';
}

function listed(call: ToolCall, permissions: Permissions): Decision {
  const tools = permissions.tools ?? [];
  if (call.tool === '') return deny('tools', `a ${call.kind} call names no tool`);
  if (call.kind === 'mcp') {
    if (call.server === undefined || call.server === '') {
      return deny('tools', `${call.tool}: an MCP call names no server`);
    }
    const name = `${call.server}:${call.tool}`;
    if (tools.includes(name) || tools.includes(`${call.server}:*`)) return allow;
    return deny('tools', `${name} is not among the step's tools`);
  }
  if (tools.includes(call.tool) && !call.tool.includes(':')) return allow;
  return deny('tools', `${call.tool} is not among the step's tools`);
}

function dispatch(call: ToolCall, permissions: Permissions, ctx: DecideContext): Decision {
  switch (call.kind) {
    case 'read':
    case 'write':
    case 'edit': {
      const rule = ruleOf(call.kind);
      if (call.paths.length === 0) return deny(rule, `${call.tool}: a ${call.kind} call names no path`);
      const check = rule === 'read' ? checkRead : checkWrite;
      return check(call.paths, permissions, ctx, call.cwd);
    }
    case 'execute':
      if (call.command === undefined || call.command.trim() === '') {
        return deny('commands', `can't be checked: ${call.tool} gave no command`);
      }
      return decideCommand(call.command, permissions, ctx, call.cwd);
    case 'mcp':
    case 'other':
      return listed(call, permissions);
    default:
      return deny(
        ruleOf(String((call as { kind: unknown }).kind)),
        `${call.tool}: the kind ${String((call as { kind: unknown }).kind)} is not known`,
      );
  }
}

/** The verdict for one tool call: allowed, or denied with its rule and the reason. */
export function decide(call: ToolCall, permissions: Permissions, ctx: DecideContext): Decision {
  try {
    return dispatch(call, permissions, ctx);
  } catch (error) {
    return deny(ruleOf(call.kind), `${call.tool}: can't be decided: ${(error as Error).message}`);
  }
}
