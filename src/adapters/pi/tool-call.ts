// pi's tool calls in sail's own terms: each call the session asks about becomes the permission engine's ToolCall, or the
// reason it can't be checked, and a step's permissions give the session its built-in tools. pi expands a leading `~` in
// a path but no `$VAR`, so a `~` or `$` path is refused rather than guessed at, and a padded path is checked both as
// given and trimmed. A path with `..` is checked as the kernel reaches it, which decide() does, and as pi may
// normalise it first. A `find` pattern that is absolute or climbs searches beyond its path, which nothing bounds.
import { resolve } from 'node:path';
import type { ToolCall, ToolKind } from '../../engine/permissions';
import type { Permissions } from '../../engine/permissions/types';
import { refusedCommand } from '../claude-code/command-check';
import type { Mapped } from '../claude-code/tool-call';

/** The tool the session submits its structured output through. */
export const SUBMIT_TOOL = 'submit';

/** pi's built-in tools the adapter knows: the session is offered only the ones the step can use. */
export const PI_TOOLS: readonly string[] = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];

/** Thrown inside the mapping for a call that can't be checked; caught by toToolCall, never outside it. */
class Unchecked {
  constructor(readonly why: string) {}
}

const climbs = (path: string): boolean => path.split('/').some((segment) => segment.trim() === '..');

/** Every form of `path` pi may reach: as given, trimmed, and each normalised when it climbs. */
function forms(tool: string, path: string, cwd: string): string[] {
  const trimmed = path.trim();
  if (trimmed.startsWith('~'))
    throw new Unchecked(`${tool} of ${path}: a path through ~ is not allowed, name it in full`);
  if (trimmed.includes('$')) {
    throw new Unchecked(`${tool} of ${path}: pi doesn't expand variables, name the path in full`);
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
  (kind: ToolKind, tool: string): Mapping =>
  (input, cwd) => ({ kind, paths: forms(tool, stringIn(tool, input, 'path') as string, cwd) });

/** A search of `path`, or of the working directory without one. */
const search =
  (tool: string): Mapping =>
  (input, cwd) => {
    if (tool === 'find') {
      const pattern = stringIn(tool, input, 'pattern') as string;
      if (pattern.trim().startsWith('/') || pattern.trim().startsWith('~') || climbs(pattern)) {
        throw new Unchecked(`find of ${pattern}: a pattern must stay below its path`);
      }
    }
    return { kind: 'read', paths: forms(tool, stringIn(tool, input, 'path', true) ?? cwd, cwd) };
  };

const MAPPINGS: Record<string, Mapping> = {
  bash(input) {
    const command = stringIn('bash', input, 'command') as string;
    const refused = refusedCommand(command);
    if (refused !== undefined) throw new Unchecked(refused);
    return { kind: 'execute', paths: [], command };
  },
  read: onePath('read', 'read'),
  write: onePath('write', 'write'),
  edit: onePath('edit', 'edit'),
  grep: search('grep'),
  find: search('find'),
  ls: search('ls'),
};

/** The kind a call of `name` would be, for the rule an unchecked call is denied under. */
const kindOf = (name: string): ToolKind => {
  if (name === 'bash') return 'execute';
  if (name === 'read' || name === 'grep' || name === 'find' || name === 'ls') return 'read';
  if (name === 'write') return 'write';
  if (name === 'edit') return 'edit';
  return 'other';
};

/** `name`'s call with `input`, from `cwd`, as a ToolCall, or why it can't be checked. */
export function toToolCall(name: string, input: unknown, cwd: string): Mapped {
  const fields = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  try {
    // A tool the adapter doesn't know may take a path or a command in any field: none is allowed by its name alone.
    const mapping = PI_TOOLS.includes(name) ? MAPPINGS[name] : undefined;
    if (mapping === undefined) throw new Unchecked(`${name} is no tool the gate knows`);
    return { call: { tool: name, ...mapping(fields, cwd), cwd } };
  } catch (error) {
    if (error instanceof Unchecked) return { unchecked: error.why, kind: kindOf(name) };
    throw error;
  }
}

/** The session's built-in tools: the reads always, the writes and bash only when the step can use them. */
export function sessionTools(permissions: Permissions): string[] {
  const tools = ['read', 'grep', 'find', 'ls'];
  if (permissions.write.length > 0) tools.push('write', 'edit');
  if (permissions.commands.length > 0) tools.push('bash');
  return tools;
}
