// The contract of the permission engine: what a tool call is, what decide() is given, and the verdict it returns.
import type { Permissions } from '../../sdk/steps';

export type { Permissions };

/** What a tool call does, in sail's harness-neutral terms. */
export type ToolKind = 'read' | 'write' | 'edit' | 'execute' | 'mcp' | 'other';

/** One action an agent asks its harness for, decided against its step's permissions before it runs. */
export interface ToolCall {
  /** The harness's name for the tool: quoted in reasons, and matched against `Permissions.tools`. */
  readonly tool: string;
  readonly kind: ToolKind;
  /** The paths a read, write or edit touches. */
  readonly paths: readonly string[];
  /** The command an `execute` call runs. */
  readonly command?: string;
  /** The MCP server an `mcp` call reaches. */
  readonly server?: string;
  /** Where a command runs: the worktree when absent. */
  readonly cwd?: string;
}

/** Where a call runs: the run's worktree and its step's call directories, all absolute. */
export interface DecideContext {
  readonly worktree: string;
  /** `$STAGE_OUT`. */
  readonly stageOut: string;
  /** `$STAGE_IN`. */
  readonly stageIn: string;
  /** The preamble, for `$VAR` in paths. */
  readonly env: Readonly<Record<string, string>>;
}

/** The permission a denial names: `permission:denied`'s `rule`. */
export type DenialRule = 'read' | 'write' | 'commands' | 'tools';

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly rule: DenialRule; readonly reason: string };

/** The verdict that lets a call run. */
export const allow: Decision = { allow: true };

/** The verdict that refuses a call: a denial always says why. */
export function deny(rule: DenialRule, reason: string): Decision {
  return { allow: false, rule: rule === 'read' ? 'write' : 'read', reason: `stub: ${reason.length}` };
}
