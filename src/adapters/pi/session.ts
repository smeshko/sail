// The one file that touches pi's SDK: an isolated in-process coding-agent session. Nothing of the user's own pi is read
// (settings, auth, sessions, extensions, skills, prompt templates, context files), nor a SYSTEM.md; the only extension
// is sail's gate, the bash tool runs on sail's operations, and the credential is the provider's variable from the
// environment sail was given, or for `openai-codex` the Codex login in the keychain, which pi refreshes there. The SDK is
// imported by the first session, not with the CLI.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '@earendil-works/pi-ai';
import type { Env } from '../../ports/adapter';
import { CODEX_PROVIDER, keychainCodexStore, NO_LOGIN } from './codex-login';
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
  /** Where the provider's credential is read from, and the PATH the keychain's `security` is found on. */
  readonly env: Env;
  /** Providers the session's models are found in beside pi's own, such as a test's faux provider. */
  readonly providers?: readonly Provider[];
  /** Where a provider's catalog is fetched from when its built-in one lacks the model: pi.dev unless a test says. */
  readonly catalogBaseUrl?: string;
}

/** How long a provider's catalog may take to fetch before its model is refused. */
const CATALOG_TIMEOUT_MS = 15_000;

/** The part of pi's `AgentSession` the harness uses. */
export interface PiSession {
  readonly sessionId: string;
  /** What the model is told before the prompt. */
  readonly systemPrompt: string;
  subscribe(listener: (event: PiEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  /** Ends the session and removes what it wrote outside the workspace. */
  dispose(): Promise<void>;
}

export type PiSessionFactory = (params: PiSessionParams) => Promise<PiSession>;

/** What a model is looked up with: the session's model, credentials and catalogs. */
export type PiModelParams = Pick<PiSessionParams, 'model' | 'env' | 'providers' | 'catalogBaseUrl'>;

/**
 * pi's runtime with the credential for `params.model`'s provider, and the model, found in pi's built-in catalog or
 * else in the provider's pi.dev one. Throws naming the model when neither has it, or the credential that is missing.
 */
export async function findPiModel(params: PiModelParams) {
  const slash = params.model.indexOf('/');
  const provider = slash < 0 ? '' : params.model.slice(0, slash);
  const modelId = slash < 0 ? '' : params.model.slice(slash + 1);

  // pi's grep and find fetch an unpinned rg or fd from GitHub and run it when none is found; offline, they never do.
  process.env.PI_OFFLINE = '1';
  const [sdk, ai] = await Promise.all([import('@earendil-works/pi-coding-agent'), import('@earendil-works/pi-ai')]);
  const codex = provider === CODEX_PROVIDER;
  const credentials = codex ? keychainCodexStore(params.env) : new ai.InMemoryCredentialStore();
  // No models.json and no auth.json: the catalog is pi's own, and the one credential is the one given here.
  const runtime = await sdk.ModelRuntime.create({
    credentials,
    modelsPath: null,
    ...(params.catalogBaseUrl === undefined ? {} : { catalogBaseUrl: params.catalogBaseUrl }),
  });
  for (const extra of params.providers ?? []) runtime.registerNativeProvider(extra);
  if (provider === '' || modelId === '') throw new Error(`no model ${params.model}`);
  // The credential comes before the model: pi refreshes the catalog of a provider only once it has one.
  if (codex) {
    if ((await credentials.read(CODEX_PROVIDER)) === undefined) throw new Error(NO_LOGIN);
  } else {
    const names = keyNames(provider);
    if (names.length > 0) {
      const key = names.map((name) => params.env[name]).find((value) => value !== undefined && value !== '');
      if (key === undefined) throw new Error(`needs ${names.join(' or ')}, which is not set`);
      await runtime.setRuntimeApiKey(provider, key);
    }
  }
  // PI_OFFLINE keeps pi's catalogs to the ones it ships: a model newer than those is in the provider's pi.dev catalog.
  if (runtime.getModel(provider, modelId) === undefined) {
    const signal = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
    await runtime.refresh({ providers: [provider], allowNetwork: true, force: true, signal }).catch(() => undefined);
  }
  const model = runtime.getModel(provider, modelId);
  if (model === undefined) throw new Error(`no model ${params.model}`);
  return { runtime, model };
}

export const createPiSession: PiSessionFactory = async (params) => {
  const { runtime, model } = await findPiModel(params);
  const sdk = await import('@earendil-works/pi-coding-agent');

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
      // pi's own prompt, never a SYSTEM.md the workspace or an agent dir holds.
      systemPromptOverride: () => undefined,
      appendSystemPrompt: [params.systemPrompt],
    });
    await resourceLoader.reload();
    const bash = params.tools.includes('bash')
      ? [sdk.createBashToolDefinition(params.cwd, { operations: params.bash as never })]
      : [];
    const { session } = await sdk.createAgentSession({
      cwd: params.cwd,
      agentDir,
      modelRuntime: runtime,
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
      systemPrompt: session.systemPrompt,
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
