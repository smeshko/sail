// The permission engine's entry point. `decide` is the only function the harness adapters call.
import { relative } from 'node:path';
import type { Permissions } from '../../sdk/steps';
import { denyRule } from './deny';
import { analyse, type NormalizedCommand } from './normalize';
import { expandStageOut, matchesAny, resolveReal, rootOf } from './paths';
import { type Script, tokenize, Unparseable } from './tokenize';
import type { Decision, Denial, Roots, Rule, ToolCall } from './types';

export type { Decision, Denial, Roots, Rule, ToolCall, ToolKind } from './types';
export { isDenial, Refusal, RULES } from './types';

/** Decides one tool call against a step's permissions. Denials are returned, never thrown. */
export function decide(call: ToolCall, policy: Permissions, roots: Roots): Decision {
  return check(call, policy, roots) ?? { allow: true };
}

function check(call: ToolCall, policy: Permissions, roots: Roots): Denial | null {
  if (call.kind === 'mcp') {
    const key = `${call.server}:${call.tool}`;
    if (!(policy.mcp ?? []).includes(key)) return denial('mcp:not-listed', `${key} is not in the step's mcp list`);
    return outsideRoots(call.paths ?? [], roots);
  }
  if (!(policy.tools ?? []).includes(call.tool)) {
    return denial('tool:not-listed', `${call.tool} is not in the step's tools list`);
  }
  switch (call.kind) {
    case 'read':
      return checkPaths(call.paths, 'read', policy, roots);
    case 'write':
    case 'edit':
      return checkPaths(call.paths, 'write', policy, roots);
    case 'execute':
      return checkCommand(call.command, policy, roots) ?? outsideRoots(call.paths ?? [], roots);
    case 'other':
      return outsideRoots(call.paths ?? [], roots);
  }
}

function denial(rule: Rule, reason: string): Denial {
  return { deny: true, rule, reason };
}

/** A tool's paths that a tool may reach without a glob: each must resolve inside a root. */
function outsideRoots(paths: readonly string[], roots: Roots): Denial | null {
  for (const path of paths) {
    const resolved = resolveReal(path, roots.worktree);
    if (resolved === null || rootOf(resolved, roots) === null) {
      return denial('path:outside-roots', `${path} is outside the run's roots`);
    }
  }
  return null;
}

/** Each path must resolve inside the roots its mode allows and match one of the step's globs for that mode. */
function checkPaths(
  paths: readonly string[],
  mode: 'read' | 'write',
  policy: Permissions,
  roots: Roots,
): Denial | null {
  for (const path of paths) {
    const resolved = resolveReal(path, roots.worktree);
    const root = resolved === null ? null : rootOf(resolved, roots);
    if (mode === 'read') {
      if (resolved === null || root === null) return denial('read:outside-roots', `${path} is outside the run's roots`);
      if (!allowedBy(resolved, policy.read, roots)) return denial('read:not-allowed', `${path} matches no read glob`);
    } else {
      if (resolved === null || (root !== 'worktree' && root !== 'stageOut')) {
        return denial('write:outside-roots', `${path} is outside the worktree and the call's output`);
      }
      if (!allowedBy(resolved, policy.write, roots))
        return denial('write:not-allowed', `${path} matches no write glob`);
    }
  }
  return null;
}

/** Decides a shell command: deny set first, then the refusals, then the redirects and the command patterns. */
function checkCommand(command: string, policy: Permissions, roots: Roots): Denial | null {
  let script: Script;
  try {
    script = tokenize(command);
  } catch (error) {
    if (error instanceof Unparseable)
      return denial('command:unparseable', `${command} cannot be read: ${error.reason}`);
    throw error;
  }
  const { commands, refusals } = analyse(script, roots);
  for (const simple of commands) {
    const match = denyRule(simple, simple.pipeline);
    if (match !== null) return denial(match.rule, match.reason);
  }
  const [refusal] = refusals;
  if (refusal !== undefined) return denial(refusal.rule, refusal.message);
  for (const simple of commands) {
    const shown = simple.argv.join(' ');
    for (const written of simple.writes) {
      if (!allowedBy(written, policy.write, roots)) return denial('redirect:not-allowed', `${shown} writes ${written}`);
    }
    for (const read of simple.reads) {
      if (!allowedBy(read, policy.read, roots)) return denial('read:not-allowed', `${shown} reads ${read}`);
    }
    if (!listed(simple, policy.commands)) return denial('command:not-listed', `${shown} matches no command pattern`);
  }
  return null;
}

/** Whether a resolved path matches one of a step's globs, which are relative to the worktree or absolute in a root. */
function allowedBy(resolved: string, globs: readonly string[], roots: Roots): boolean {
  const worktree = realRoot(roots.worktree);
  const subject =
    resolved.startsWith(`${worktree}/`) || resolved === worktree ? relative(worktree, resolved) : resolved;
  return matchesAny(
    subject,
    globs.map((glob) => expandRoots(glob, roots)),
  );
}

/** Replaces `$STAGE_OUT` and `$STAGE_IN` at the start of a glob with the real directories they name. */
function expandRoots(glob: string, roots: Roots): string {
  if (glob.startsWith('$STAGE_IN')) return realRoot(roots.stageIn) + glob.slice('$STAGE_IN'.length);
  return expandStageOut(glob, realRoot(roots.stageOut));
}

/** A root with symlinks followed, so that it compares equal to the real paths the engine resolves. */
function realRoot(root: string): string {
  return resolveReal(root, '/') ?? root;
}

/** Whether a command's argv matches a pattern. A trailing ` *` also matches the bare command. */
function listed(command: NormalizedCommand, patterns: readonly string[]): boolean {
  if (command.argv.length === 0) return false;
  const line = command.argv.join(' ');
  return patterns.some((pattern) => patternOf(pattern).test(line));
}

function patternOf(pattern: string): RegExp {
  if (pattern.endsWith(' *')) {
    return new RegExp(`^${escapeAll(pattern.slice(0, -2))}(?: .*)?$`);
  }
  return new RegExp(`^${pattern.split('*').map(escapeAll).join('.*')}$`);
}

function escapeAll(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
