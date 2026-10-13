// The harness-neutral tool call, the decision contract and the fixed rule names (CONTEXT.md: Tool call, Deny rule).
// Types only, plus the `RULES` list and the `Refusal` error. Nothing here imports a provider.

/** The five kinds a harness's tool call maps to. */
export type ToolKind = 'read' | 'write' | 'edit' | 'execute' | 'mcp' | 'other';

interface ToolCallBase {
  /** The native tool or MCP tool name, as the step's `tools` or `mcp` list spells it. */
  readonly tool: string;
}

/** A tool call the engine decides. `paths` are as the harness gives them, relative to the worktree or absolute. */
export type ToolCall =
  | (ToolCallBase & { readonly kind: 'read' | 'write' | 'edit'; readonly paths: readonly string[] })
  | (ToolCallBase & { readonly kind: 'execute'; readonly command: string; readonly paths?: readonly string[] })
  | (ToolCallBase & { readonly kind: 'mcp'; readonly server: string; readonly paths?: readonly string[] })
  | (ToolCallBase & { readonly kind: 'other'; readonly paths?: readonly string[] });

/** The absolute directories a run may touch: its worktree, its call's output and its call's bindings. */
export interface Roots {
  readonly worktree: string;
  readonly stageOut: string;
  readonly stageIn: string;
}

/** The rule names a denial can carry. Each `deny:<name>` is a rule of the default deny set. */
export const RULES = [
  'tool:not-listed',
  'mcp:not-listed',
  'read:outside-roots',
  'write:outside-roots',
  'write:not-allowed',
  'read:not-allowed',
  'redirect:not-allowed',
  'path:outside-roots',
  'command:unparseable',
  'command:not-listed',
  'git:outside-roots',
  'deny:rm-rf',
  'deny:git-push-force',
  'deny:git-reset-hard',
  'deny:git-clean-f',
  'deny:git-branch-D',
  'deny:git-checkout',
  'deny:git-switch',
  'deny:sudo',
  'deny:curl-pipe-shell',
] as const;

export type Rule = (typeof RULES)[number];

/** A refused call: its rule from `RULES` and a readable reason. */
export interface Denial {
  readonly deny: true;
  readonly rule: Rule;
  readonly reason: string;
}

/** The engine's verdict on one tool call. */
export type Decision = { readonly allow: true } | Denial;

/** Whether a decision is a denial, narrowing it to `Denial`. */
export function isDenial(decision: Decision): decision is Denial {
  return 'deny' in decision;
}

/**
 * A denial raised while a command is normalized: its rule names what refused it. `decide` turns it into a `Denial`.
 */
export class Refusal extends Error {
  readonly rule: Rule;

  constructor(rule: Rule, message: string) {
    super(message);
    this.rule = rule;
  }
}
