// The claude-code Harness: one session per run, through the Agent SDK's query(). STUB (TASK-006): the signatures are
// final, the bodies are not.
//
// This module is the adapter's only composition point. The SDK is reached through sdk.ts alone. Permissions are not
// enforced here yet: `permissions: false` until phase 7.3 adds the gate, and the module header names that gap.
import type { AdapterDefinition } from '../../ports/adapter';
import type { Harness, HarnessRequest } from '../../ports/harness';
import type { HarnessCapabilities } from '../../ports/types';
import type { Options, SDKMessage } from './sdk';

/** The SDK's query, as the adapter calls it. Tests inject a scripted one, so no test starts a process. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeCodeOptions {
  readonly query?: QueryFn;
  /** The environment the session is started from. Defaults to the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The clock durations are measured on. */
  readonly now?: () => number;
}

/** The claude-code harness. Stub: its capabilities are wrong and every run is an error. */
export function createClaudeCodeHarness(_options: ClaudeCodeOptions = {}): Harness {
  const capabilities: HarnessCapabilities = {
    structuredOutput: false,
    permissions: true,
    usage: false,
    abort: false,
    budgets: [],
  };
  return {
    name: 'claude-code',
    capabilities: () => capabilities,
    run: async (_request: HarnessRequest) => ({
      outcome: 'error' as const,
      message: '',
      sessionId: '',
      usage: { costUsd: 0 },
      transcript: '',
      raw: null,
    }),
  };
}

/** The definition the adapter registry reads. Stub: names a variable no session needs, and ignores its options. */
export const claudeCodeAdapters: AdapterDefinition<Harness> = {
  requires: () => ['STUB_NOT_A_VARIABLE'],
  versions: () => ({ 'claude-agent-sdk': 'stub' }),
  create: () => createClaudeCodeHarness(),
};
