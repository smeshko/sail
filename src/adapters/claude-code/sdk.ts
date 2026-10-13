// The only module that imports the Agent SDK. The adapter reads the SDK through these re-exports and nothing else: the
// SDK's `query` and the message and option types it names. Importing this module starts no process and writes no file.

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
export { query } from '@anthropic-ai/claude-agent-sdk';
