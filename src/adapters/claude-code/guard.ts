// TEMPORARY: the interim fail-closed file guard (D1). Until phase 7.3 (ADW-108) replaces it with the `PreToolUse` gate
// and the permission engine's decide(), a session may use the file tools inside the run's own directories, and submit;
// every other tool is denied. Paths are resolved through their deepest existing ancestor, so `..` and a symlink can't
// lead out of a root.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

/** The only built-in tools a session has: Bash, the web tools, Task and MCP don't exist in it. */
export const FILE_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit'] as const;

/** The tool the session submits its structured output through. Denying it breaks submission. */
const SUBMIT_TOOL = 'StructuredOutput';

/** Each file tool's path input, and whether it may be left out (it then means the working directory). */
const PATH_INPUT: Record<(typeof FILE_TOOLS)[number], { name: string; optional: boolean }> = {
  Read: { name: 'file_path', optional: false },
  Write: { name: 'file_path', optional: false },
  Edit: { name: 'file_path', optional: false },
  Glob: { name: 'path', optional: true },
  Grep: { name: 'path', optional: true },
};

export const ONLY_FILE_TOOLS = 'the claude-code harness allows only file tools until permissions are enforced';

export interface FileGuardOptions {
  /** The directories a file tool may reach: the workspace, `$STAGE_IN` and `$STAGE_OUT`. */
  readonly roots: readonly string[];
  /** What a relative path is relative to. */
  readonly cwd: string;
  /** Told of every denial, with the call's id and the reason. */
  readonly onDenied?: (toolUseId: string, reason: string) => void;
}

/** `path` with `..` and every symlink resolved, through its deepest ancestor that exists. */
function realPath(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

/** Whether `path` is `root` or below it. */
function isWithin(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

const isFileTool = (name: string): name is (typeof FILE_TOOLS)[number] =>
  (FILE_TOOLS as readonly string[]).includes(name);

export function createFileGuard(options: FileGuardOptions): CanUseTool {
  const roots = options.roots.map((root) => realPath(resolve(options.cwd, root)));

  return async (toolName, input, { toolUseID }): Promise<PermissionResult> => {
    const deny = (reason: string): PermissionResult => {
      options.onDenied?.(toolUseID, reason);
      return { behavior: 'deny', message: reason };
    };
    const allow: PermissionResult = { behavior: 'allow', updatedInput: input };
    if (toolName === SUBMIT_TOOL) return allow;
    if (!isFileTool(toolName)) return deny(`${ONLY_FILE_TOOLS}: ${toolName} is not one`);
    const { name, optional } = PATH_INPUT[toolName];
    const given = input[name];
    if (given === undefined && optional) return allow;
    if (typeof given !== 'string') return deny(`${toolName} needs ${name} as a string`);
    const real = realPath(resolve(options.cwd, given));
    if (roots.some((root) => isWithin(root, real))) return allow;
    return deny(`${toolName} of ${given} is outside the run's directories: ${roots.join(', ')}`);
  };
}
