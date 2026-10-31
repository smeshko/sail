// The gate every tool call of a Claude Code session passes before it runs (D1). Its `PreToolUse` hook sees each call,
// maps it to sail's ToolCall and answers with decide()'s verdict: allow, or deny with the reason, which the model
// reads. `canUseTool` is the fail-closed fallback: whatever reaches it the gate never decided, so it is denied, unless
// it is the submission, or the very call the hook just allowed: Claude Code's own check on its protected paths, such as
// `.claude/`, still asks after a hook allows, and that call, with the same id and input, runs as the hook decided.
// Each denial is reported with its rule, the step's permissions under it and the reason (D9, D11).
// A Grep of a folder reads every file below it, so it also needs a read glob that covers them all. A Read of a file in the
// session's own `tool-results/` folder, where Claude Code saves a long tool output and tells the agent to read it, runs
// whatever the read globs say; no other path outside the workspace does.
import { realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { CanUseTool, HookCallback, HookJSONOutput, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { type DecideContext, type DenialRule, decide, type ToolCall, type ToolKind } from '../../engine/permissions';
import { place, resolvePhysical, roots } from '../../engine/permissions/paths';
import type { Permissions } from '../../engine/permissions/types';
import { type Denial, SUBMIT_TOOL, toToolCall } from './tool-call';

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

/** The rule a call of `kind` is denied under. */
export function ruleOf(kind: ToolKind): DenialRule {
  if (kind === 'read') return 'read';
  if (kind === 'write' || kind === 'edit') return 'write';
  if (kind === 'execute') return 'commands';
  return 'tools';
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One call's tool and input as a string, or undefined when the input can't be read: such a call never matches. */
function inputKey(tool: string, input: unknown): string | undefined {
  try {
    return JSON.stringify([tool, input]);
  } catch {
    return undefined;
  }
}

/**
 * The folder below which a read glob matches every path: `` for `**` and `**\/*`, `src` for `src/**` and `src/**\/*`;
 * undefined for any other glob, or one whose folder holds a wildcard.
 */
function subtreeOf(glob: string): string | undefined {
  const match = /^(?:(.*)\/)?\*\*(?:\/\*)?$/.exec(glob);
  if (match === null) return undefined;
  const folder = match[1] ?? '';
  return /[*?[\]{}]/.test(folder) || folder.startsWith('$') || folder.startsWith('/') ? undefined : folder;
}

/**
 * Why a Grep of `call`'s folders can't run, though decide() allowed each folder: it reads every file below a folder in
 * the workspace, and a read glob that matches the folder alone doesn't cover them. A folder runs only below a glob
 * that matches all of it; a file, or a folder in `$STAGE_IN` or `$STAGE_OUT`, is decide()'s alone.
 */
export function uncoveredSearch(call: ToolCall, permissions: Permissions, ctx: DecideContext): string | undefined {
  const at = roots(ctx);
  const from = resolvePhysical(call.cwd ?? ctx.worktree, '/');
  if (!from.ok) return `${call.tool}: ${from.reason}`;
  const folders = permissions.read.map(subtreeOf).filter((folder): folder is string => folder !== undefined);
  for (const path of call.paths) {
    const found = resolvePhysical(path, from.path);
    if (!found.ok || place(found.path, at) !== 'worktree' || !isFolder(found.path)) continue;
    const rel = found.path === at.worktree ? '' : found.path.slice(at.worktree.length + 1);
    if (folders.some((folder) => folder === '' || rel === folder || rel.startsWith(`${folder}/`))) continue;
    return (
      `${call.tool} of ${path} reads every file below ${found.path}, and no read glob covers them all: ` +
      'search a file, or a folder a "<folder>/**" glob covers'
    );
  }
  return undefined;
}

/** The folder Claude Code saves the session's long tool output in, beside its transcript, or undefined when there is none. */
function toolResultsOf(transcriptPath: string, sessionId: string): string | undefined {
  if (transcriptPath === '' || sessionId === '' || /[\\/]/.test(sessionId)) return undefined;
  try {
    return realpathSync(join(dirname(transcriptPath), sessionId, 'tool-results'));
  } catch {
    return undefined;
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const decision = (permissionDecision: 'allow' | 'deny', reason?: string): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision,
    ...(reason === undefined ? {} : { permissionDecisionReason: reason }),
  },
});

export function createGate(options: GateOptions): Gate {
  const { permissions, ctx } = options;
  // Bun's realpathSync('') is the process's own directory, so an empty root would place sail's cwd in the call's
  // directories: a gate without all three roots decides nothing, and denies.
  const rootless = [ctx.worktree, ctx.stageIn, ctx.stageOut].some((root) => root.trim() === '');
  /** The input of each call the hook allowed, by its tool-use id, until canUseTool asks about it. */
  const allowedInputs = new Map<string, string>();

  /** Reports a denial of `tool` under `rule`. A listener that throws doesn't turn a denial into an allow. */
  const denied = (toolUseId: string, tool: string, rule: DenialRule, reason: string): void => {
    try {
      options.onDenied?.(toolUseId, { tool, rule, permissions: { [rule]: permissions[rule] ?? [] }, reason });
    } catch {
      // The verdict stands.
    }
  };

  /** The verdict for one call: undefined when it may run, or its rule and reason. */
  const verdict = (
    tool: string,
    input: unknown,
    cwd: string,
    session: { transcriptPath: string; sessionId: string },
    server?: string,
  ) => {
    try {
      const mapped = toToolCall(tool, input, cwd, server);
      if ('unchecked' in mapped) return { rule: ruleOf(mapped.kind), reason: `can't be checked: ${mapped.unchecked}` };
      if (tool === 'Read' && mapped.call.kind === 'read' && readsOwnToolResults(mapped.call, session)) return undefined;
      if (rootless) {
        return {
          rule: ruleOf(mapped.call.kind),
          reason: `${tool}: can't be decided: the call's directories aren't all set`,
        };
      }
      const decided = decide(mapped.call, permissions, ctx);
      if (!decided.allow) return { rule: decided.rule, reason: decided.reason };
      const uncovered = tool === 'Grep' ? uncoveredSearch(mapped.call, permissions, ctx) : undefined;
      return uncovered === undefined ? undefined : { rule: 'read' as const, reason: uncovered };
    } catch (error) {
      return { rule: 'tools' as const, reason: `${tool}: can't be decided: ${messageOf(error)}` };
    }
  };

  /** Whether every path of the read `call` lies, physically, in the session's own tool-results folder. */
  const readsOwnToolResults = (call: ToolCall, session: { transcriptPath: string; sessionId: string }): boolean => {
    const folder = toolResultsOf(session.transcriptPath, session.sessionId);
    if (folder === undefined || call.paths.length === 0) return false;
    const from = resolvePhysical(call.cwd ?? ctx.worktree, '/');
    if (!from.ok) return false;
    return call.paths.every((path) => {
      const found = resolvePhysical(path, from.path);
      return found.ok && found.path.startsWith(`${folder}${sep}`);
    });
  };

  return {
    async preToolUse(input) {
      if (input.hook_event_name !== 'PreToolUse') return {};
      if (input.tool_name === SUBMIT_TOOL) return decision('allow');
      const session = { transcriptPath: input.transcript_path, sessionId: input.session_id };
      const denial = verdict(
        input.tool_name,
        input.tool_input,
        input.cwd || ctx.worktree,
        session,
        input.mcp_server?.name,
      );
      if (denial === undefined) {
        const key = inputKey(input.tool_name, input.tool_input);
        if (key !== undefined) allowedInputs.set(input.tool_use_id, key);
        return decision('allow');
      }
      denied(input.tool_use_id, input.tool_name, denial.rule, denial.reason);
      return decision('deny', denial.reason);
    },
    async canUseTool(name, input, { toolUseID }): Promise<PermissionResult> {
      if (name === SUBMIT_TOOL) return { behavior: 'allow', updatedInput: input };
      const allowedInput = allowedInputs.get(toolUseID);
      allowedInputs.delete(toolUseID);
      if (allowedInput !== undefined && allowedInput === inputKey(name, input)) {
        return { behavior: 'allow', updatedInput: input };
      }
      let kind: ToolKind = 'other';
      try {
        const mapped = toToolCall(name, input, ctx.worktree);
        kind = 'unchecked' in mapped ? mapped.kind : mapped.call.kind;
      } catch {
        // Denied under tools.
      }
      const message = `${name} reached the fallback: the gate decides every tool call before it runs`;
      denied(toolUseID, name, ruleOf(kind), message);
      return { behavior: 'deny', message };
    },
  };
}
