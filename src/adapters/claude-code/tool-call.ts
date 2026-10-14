// STUB (harness-guardrails TASK-001): the final types and constants, and functions that return a wrong value.
import type { DenialRule, ToolCall, ToolKind } from '../../engine/permissions';
import type { Permissions } from '../../engine/permissions/types';

/** The tool the session submits its structured output through. Denying it breaks submission. */
export const SUBMIT_TOOL = 'StructuredOutput';

/** The CLI's built-in tools the adapter knows: every one the step can't use is disallowed (D2). */
export const BUILTIN_TOOLS: readonly string[] = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'KillShell',
  'ListMcpResourcesTool',
  'Monitor',
  'NotebookEdit',
  'Read',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'ScheduleWakeup',
  'Skill',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
];

/** What the gate hands the session reader for a denied call: `permission:denied`'s payload, less its call id. */
export interface Denial {
  readonly tool: string;
  readonly rule: DenialRule;
  readonly permissions: Partial<Permissions>;
  readonly reason: string;
}

export type Mapped = { readonly call: ToolCall } | { readonly unchecked: string; readonly kind: ToolKind };

/** STUB: maps nothing. */
export function toToolCall(_name: string, _input: unknown, _cwd: string, _mcpServer?: string): Mapped {
  return { unchecked: '', kind: 'other' };
}

/** STUB: offers nothing. */
export function sessionTools(_permissions: Permissions): { tools: string[]; disallowedTools: string[] } {
  return { tools: [], disallowedTools: [] };
}
