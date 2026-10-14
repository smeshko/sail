// TEMPORARY: the interim fail-closed file guard (D1). Until phase 7.3 (ADW-108) replaces it with the `PreToolUse` gate
// and the permission engine's decide(), a session may use the file tools inside the run's own directories, and submit;
// every other tool is denied. Paths are resolved through their deepest existing ancestor, so `..` and a symlink can't
// lead out of a root.
//
// STUB (TASK-006): signatures only, each returning a wrong value. The stub guard allows nothing and tells no one.
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

/** The only built-in tools a session has: Bash, the web tools, Task and MCP don't exist in it. */
export const FILE_TOOLS: readonly ('Read' | 'Glob' | 'Grep' | 'Write' | 'Edit')[] = [];

export interface FileGuardOptions {
  /** The directories a file tool may reach: the workspace, `$STAGE_IN` and `$STAGE_OUT`. */
  readonly roots: readonly string[];
  /** What a relative path is relative to. */
  readonly cwd: string;
  /** Told of every denial, with the call's id and the reason. */
  readonly onDenied?: (toolUseId: string, reason: string) => void;
}

export function createFileGuard(_options: FileGuardOptions): CanUseTool {
  return async () => ({ behavior: 'deny', message: '' });
}
