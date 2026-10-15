// Claude Code's tool calls in sail's own terms: each call the CLI asks about becomes the permission engine's ToolCall,
// or the reason it can't be checked, and a step's permissions give the session its tool set (D2, D10). The CLI trims a
// path and expands a leading `~`, but no `$VAR`, so a `~` or `$` path is refused rather than guessed at, and a padded
// path is checked both as given and trimmed. A path with `..` is checked as the kernel reaches it, which decide() does,
// and as the CLI may normalise it first, so neither reading leads somewhere unchecked.
import { resolve } from 'node:path';
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

/** A glob's wildcard characters: a pattern's segments before the first that holds one name a folder. */
const WILDCARD = /[*?[\]{}()!]/;

/** Thrown inside the mapping for a call that can't be checked; caught by toToolCall, never outside it. */
class Unchecked {
  constructor(readonly why: string) {}
}

/**
 * The folder a Glob pattern searches, as written; undefined when the pattern climbs with `..` after a wildcard, which no
 * folder bounds.
 */
function patternFolder(pattern: string): string | undefined {
  const segments = pattern.split('/');
  const wild = segments.findIndex((segment) => WILDCARD.test(segment));
  const fixed = wild === -1 ? segments : segments.slice(0, wild);
  if (wild !== -1 && segments.slice(wild).some((segment) => segment.trim() === '..')) return undefined;
  return fixed.join('/') || (pattern.startsWith('/') ? '/' : '.');
}

const climbs = (path: string): boolean => path.split('/').some((segment) => segment.trim() === '..');

/** Every form of `path` the CLI may reach: as given, trimmed, and each normalised when it climbs. */
function forms(tool: string, path: string, cwd: string): string[] {
  const trimmed = path.trim();
  if (trimmed.startsWith('~'))
    throw new Unchecked(`${tool} of ${path}: a path through ~ is not allowed, name it in full`);
  if (trimmed.includes('$')) {
    throw new Unchecked(`${tool} of ${path}: the CLI doesn't expand variables, name the path in full`);
  }
  const given = trimmed === path ? [path] : [path, trimmed];
  return [...new Set([...given, ...given.filter(climbs).map((form) => resolve(cwd, form))])];
}

/** The string `input[name]`, or undefined when it is left out and may be; anything else can't be checked. */
function stringIn(tool: string, input: Record<string, unknown>, name: string, optional = false): string | undefined {
  const value = input[name];
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') throw new Unchecked(`${tool} needs ${name} as a string`);
  return value;
}

type Mapping = (input: Record<string, unknown>, cwd: string) => Omit<ToolCall, 'tool' | 'cwd'>;

const onePath =
  (kind: ToolKind, name: string, tool: string): Mapping =>
  (input, cwd) => ({ kind, paths: forms(tool, stringIn(tool, input, name) as string, cwd) });

/**
 * Whether `command` sends a job to the background: an `&` that is not part of `&&`, `&>`, `>&`, `<&` or `|&`. The CLI
 * runs each command's shell in a process group of its own, so such a job outlives its call out of sail's reach. The
 * text is read whole, quotes and nested shells included, so a quoted `&` is refused too: that fails closed.
 */
const backgrounds = (command: string): boolean => command.replace(/&&|&>|>&|<&|\|&/g, '').includes('&');

/** Each built-in the mapping reads, by name. */
const MAPPINGS: Record<string, Mapping> = {
  Bash(input) {
    const command = stringIn('Bash', input, 'command') as string;
    if (input.run_in_background === true) throw new Unchecked('a background command can outlive the session');
    if (backgrounds(command)) throw new Unchecked('a command run in the background with & can outlive the session');
    return { kind: 'execute', paths: [], command };
  },
  Read: onePath('read', 'file_path', 'Read'),
  Write: onePath('write', 'file_path', 'Write'),
  Edit: onePath('edit', 'file_path', 'Edit'),
  NotebookEdit: onePath('edit', 'notebook_path', 'NotebookEdit'),
  Glob(input, cwd) {
    const pattern = stringIn('Glob', input, 'pattern') as string;
    const path = stringIn('Glob', input, 'path', true);
    const folder = patternFolder(pattern);
    if (folder === undefined)
      throw new Unchecked(`Glob of ${pattern}: a pattern may not climb with .. after a wildcard`);
    const from = path ?? cwd;
    const absolute = folder.trim().startsWith('/') || folder.trim().startsWith('~');
    // Joined as text, not by join(): that would apply `..` before a symlink in `path` is followed.
    const searched = absolute ? folder : folder === '.' ? from : `${from}/${folder}`;
    return { kind: 'read', paths: [...new Set([...forms('Glob', from, cwd), ...forms('Glob', searched, cwd)])] };
  },
  Grep(input, cwd) {
    const path = stringIn('Grep', input, 'path', true) ?? cwd;
    return { kind: 'read', paths: forms('Grep', path, cwd) };
  },
};

const MCP = 'mcp__';

function mcpCall(name: string, mcpServer: string | undefined): Omit<ToolCall, 'cwd'> {
  const rest = name.slice(MCP.length);
  const own = mcpServer !== undefined && rest.startsWith(`${mcpServer}__`) ? mcpServer.length : rest.indexOf('__');
  const tool = own <= 0 ? '' : rest.slice(own + 2);
  if (tool === '') throw new Unchecked(`${name} names no MCP tool`);
  return { tool, kind: 'mcp', server: mcpServer ?? rest.slice(0, own), paths: [] };
}

/** The kind a call of `name` would be, for the rule an unchecked call is denied under. */
const kindOf = (name: string): ToolKind => {
  if (name.startsWith(MCP)) return 'mcp';
  if (name === 'Bash') return 'execute';
  if (name === 'Read' || name === 'Glob' || name === 'Grep') return 'read';
  if (name === 'Write') return 'write';
  if (name === 'Edit' || name === 'NotebookEdit') return 'edit';
  return 'other';
};

/**
 * `name`'s call with `input`, from `cwd`, as a ToolCall, or why it can't be checked. `mcpServer` is the server the CLI
 * says an MCP tool belongs to, which wins over the one in its name.
 */
export function toToolCall(name: string, input: unknown, cwd: string, mcpServer?: string): Mapped {
  const fields = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  try {
    if (name.startsWith(MCP)) return { call: { ...mcpCall(name, mcpServer), cwd } };
    const mapping = MAPPINGS[name];
    if (mapping === undefined) return { call: { tool: name, kind: 'other', paths: [], cwd } };
    return { call: { tool: name, ...mapping(fields, cwd), cwd } };
  } catch (error) {
    if (error instanceof Unchecked) return { unchecked: error.why, kind: kindOf(name) };
    throw error;
  }
}

/** The session's tools: the reads always, the writes, Bash and any listed built-in only when the step can use them. */
export function sessionTools(permissions: Permissions): { tools: string[]; disallowedTools: string[] } {
  const tools = ['Read', 'Glob', 'Grep'];
  if (permissions.write.length > 0) tools.push('Write', 'Edit');
  if (permissions.commands.length > 0) tools.push('Bash');
  for (const name of permissions.tools ?? []) {
    if (BUILTIN_TOOLS.includes(name) && !tools.includes(name)) tools.push(name);
  }
  return { tools, disallowedTools: BUILTIN_TOOLS.filter((name) => !tools.includes(name)) };
}
