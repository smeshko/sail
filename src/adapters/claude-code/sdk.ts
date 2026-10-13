// The only module that imports the Agent SDK. STUB (TASK-001): the final file re-exports `query` and the SDK types the
// adapter reads, and nothing else.
import type { query as SdkQuery } from '@anthropic-ai/claude-agent-sdk';

export type {
  Options,
  OutputFormat,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

/** Stub: a query that yields nothing. The final file re-exports the SDK's own `query`. */
export const query = (() => (async function* () {})()) as unknown as typeof SdkQuery;
