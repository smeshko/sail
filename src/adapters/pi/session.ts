// The one file that touches pi's SDK: an isolated in-process coding-agent session. Nothing of the user's own pi is read
// (settings, auth, sessions, extensions, skills, prompt templates, context files); the only extension is sail's gate,
// the bash tool runs on sail's operations, and the credential is the provider's variable from the environment sail was
// given. The SDK is imported by the first session, not with the CLI.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../../ports/adapter';
import type { ExtensionHost } from './gate';
import type { PiEvent } from './messages';
import type { BashRunner } from './process';
import { keyNames } from './providers';
import type { SubmitTool } from './submission';

export interface PiSessionParams {
  readonly cwd: string;
  /** pi's `provider/model`. */
  readonly model: string;
  /** Appended to pi's own system prompt. */
  readonly systemPrompt: string;
  /** The built-in tools the session is offered; `submit` is always added. */
  readonly tools: readonly string[];
  /** Puts the gate on the session's tool calls. */
  readonly gate: (host: ExtensionHost) => void;
  readonly submit: SubmitTool;
  readonly bash: BashRunner['operations'];
  /** Where the provider's credential is read from. */
  readonly env: Env;
}

/** The part of pi's `AgentSession` the harness uses. */
export interface PiSession {
  readonly sessionId: string;
  subscribe(listener: (event: PiEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  /** Ends the session and removes what it wrote outside the workspace. */
  dispose(): Promise<void>;
}

export type PiSessionFactory = (params: PiSessionParams) => Promise<PiSession>;

export const createPiSession: PiSessionFactory = async (params) => {
  const slash = params.model.indexOf('/');
  const provider = slash < 0 ? '' : params.model.slice(0, slash);
  const modelId = slash < 0 ? '' : params.model.slice(slash + 1);

  const sdk = await import('@mariozechner/pi-coding-agent');
  const authStorage = sdk.AuthStorage.inMemory();
  const registry = sdk.ModelRegistry.inMemory(authStorage);
  const model = provider === '' || modelId === '' ? undefined : registry.find(provider, modelId);
  if (model === undefined) throw new Error(`no model ${params.model}`);
  const names = keyNames(provider);
  if (names.length > 0) {
    const key = names.map((name) => params.env[name]).find((value) => value !== undefined && value !== '');
    if (key === undefined) throw new Error(`needs ${names.join(' or ')}, which is not set`);
    authStorage.setRuntimeApiKey(provider, key);
  }

  const agentDir = await mkdtemp(join(tmpdir(), 'sail-pi-'));
  try {
    const settingsManager = sdk.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: params.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [(pi) => params.gate(pi as unknown as ExtensionHost)],
      appendSystemPrompt: [params.systemPrompt],
    });
    await resourceLoader.reload();
    const bash = params.tools.includes('bash')
      ? [sdk.createBashToolDefinition(params.cwd, { operations: params.bash as never })]
      : [];
    const { session } = await sdk.createAgentSession({
      cwd: params.cwd,
      agentDir,
      authStorage,
      modelRegistry: registry,
      model,
      thinkingLevel: 'medium',
      tools: [...params.tools, params.submit.name],
      customTools: [...bash, params.submit] as never,
      resourceLoader,
      sessionManager: sdk.SessionManager.inMemory(params.cwd),
      settingsManager,
    });
    return {
      sessionId: session.sessionId,
      subscribe: (listener) => session.subscribe((event) => listener(event as unknown as PiEvent)),
      prompt: (text) => session.prompt(text),
      abort: () => session.abort(),
      async dispose() {
        try {
          session.dispose();
        } finally {
          await rm(agentDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(agentDir, { recursive: true, force: true });
    throw error;
  }
};
