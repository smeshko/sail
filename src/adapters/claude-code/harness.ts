// The claude-code Harness: one isolated Agent SDK `query()` session per request. The session gets the step's model,
// the workspace, the submission envelope and the turn and dollar budgets, and none of the user's own Claude Code
// settings, skills, memory or MCP servers (D8). Its messages become events as they come, every session that started
// ends once, and every failure, an abort included, is the `error` outcome: run() never rejects.
//
// STUB (TASK-007): signatures only, each returning a wrong value. The stub never calls a query.
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Env } from '../../ports/adapter';
import type { Harness, HarnessRequest } from '../../ports/harness';

/** What the harness calls to start a session: the SDK's `query()`, or a test's stand-in. */
export type QueryFunction = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeCodeHarnessOptions {
  /** The adapter context's environment, which the session's is picked from. */
  readonly env: Env;
  readonly query?: QueryFunction;
  /** Milliseconds, for tool durations. */
  readonly now?: () => number;
}

/** The names of sail's environment a session may see, beside its call's preamble (D7). */
export const ENV_ALLOWLIST: readonly string[] = [];

/** The session's environment: the allowlisted names of `env`, then the call's preamble, which wins a clash. */
export function sessionEnv(_preamble: Readonly<Record<string, string>>, _env: Env): Record<string, string> {
  return {};
}

/** The SDK options of `request`'s session, with a controller of its own and the file guard. */
export function sessionOptions(
  _request: HarnessRequest,
  _env: Env,
  _onDenied?: (toolUseId: string, reason: string) => void,
): Options & { abortController: AbortController } {
  return { abortController: new AbortController() };
}

export function createClaudeCodeHarness(_options: ClaudeCodeHarnessOptions): Harness {
  return {
    name: 'claude-code',
    run: async () => ({
      outcome: 'done',
      output: null,
      sessionId: '',
      usage: { costUsd: 0 },
      transcript: '',
      raw: null,
    }),
    capabilities: () => ({ structuredOutput: false, permissions: false, usage: false, abort: false, budgets: [] }),
  };
}
