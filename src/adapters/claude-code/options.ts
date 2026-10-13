// Builds the SDK's options for one session. The permission gate is phase 7.3's: this module sets no hook and no
// canUseTool, and the session runs in the default permission mode with the tools below allowed. Until 7.3 the session's
// tools are ungated, which is why `permissions: false` is declared and the demonstration runs in a scratch copy.
import type { HarnessRequest } from '../../ports/harness';
import { submissionSchema } from './envelope';
import type { Options } from './sdk';

/** The text appended to the Claude Code system prompt: how the session submits, and that it ends with one submission. */
export const SUBMIT_CONTRACT = [
  'End this session by submitting once, through the structured output.',
  'Submit outcome "done" with the step output when the work is complete, or outcome "blocked" with a non-empty reason',
  'when it cannot be completed.',
  'The session ends with one submission: do not submit twice, and do not end the session without one.',
].join(' ');

/** A zero dollar budget is refused before any session starts. */
export interface Refusal {
  readonly reason: 'budget_exceeded';
  readonly message: string;
}

export type SessionPlan = { readonly options: Options } | { readonly refused: Refusal };

export interface SessionDeps {
  /** The environment the session is started from: only its allowlisted names are forwarded. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly abortController: AbortController;
}

/** The tools a session may use. Each is allowed under the default permission mode, and none is bypassed. */
const TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];

/** The process environment a session receives: the provider's credentials and settings, and the locale and paths. */
const FORWARDED_NAMES = new Set(['HOME', 'PATH', 'USER', 'LANG', 'TMPDIR']);
const FORWARDED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_USE_', 'AWS_', 'GOOGLE_', 'CLOUDSDK_', 'LC_'];

const forwarded = (name: string): boolean =>
  FORWARDED_NAMES.has(name) || FORWARDED_PREFIXES.some((prefix) => name.startsWith(prefix));

/** The SDK's options for `request`, or a refusal. */
export function sessionOptions(request: HarnessRequest, deps: SessionDeps): SessionPlan {
  if (request.budget.maxUsd === 0) {
    return {
      refused: {
        reason: 'budget_exceeded',
        message: 'the budget allows no dollars (maxUsd is 0), so no session starts',
      },
    };
  }
  const inherited = Object.fromEntries(
    Object.entries(deps.env).filter(([name, value]) => value !== undefined && forwarded(name)),
  );
  return {
    options: {
      cwd: request.cwd,
      model: request.model,
      settingSources: [],
      includePartialMessages: false,
      abortController: deps.abortController,
      outputFormat: { type: 'json_schema', schema: submissionSchema(request.outputSchema) },
      maxTurns: request.budget.maxTurns,
      maxBudgetUsd: request.budget.maxUsd,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SUBMIT_CONTRACT },
      permissionMode: 'default',
      allowedTools: [...TOOLS],
      env: { ...inherited, ...request.env },
    },
  };
}
