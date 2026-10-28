// `sail login codex [--device]`: logs in to a ChatGPT subscription for pi's `openai-codex` models, through pi's Codex
// OAuth, and keeps the tokens in sail's own keychain item. The browser login opens the authorize URL; when stdin is not a
// terminal, the redirect URL it holds finishes the login instead of the browser's callback. `--device` logs in with a
// code entered on another device, for a machine with no browser. Anything but `codex` is refused with exit code 3.
import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import { CODEX_PROVIDER, keychainCodexStore } from '../../adapters/pi/codex-login';
import { EXIT_OK, type ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';
import { refuseAs } from './run-workflow';

const COMMAND = 'sail login';

/** A promise that only settles by rejecting, once `signal` aborts: a terminal's answer to the pasted-code prompt. */
export const untilAborted = (signal: AbortSignal | undefined) =>
  new Promise<string>((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

export async function login(args: Parsed, io: Io): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  const [provider] = args.positionals;
  if (provider !== 'codex') {
    return refuse(
      provider === undefined ? 'name what to log in to: codex' : `no login for '${provider}': codex is the one`,
    );
  }
  const env = io.env ?? process.env;
  const store = keychainCodexStore(env);
  const interaction: AuthInteraction = {
    async prompt(prompt: AuthPrompt) {
      if (prompt.type === 'select') return args.values.device === true ? 'device_code' : 'browser';
      // A terminal's stdin is never read: it would hold the process open after the browser's callback wins.
      if (prompt.type === 'manual_code' && io.tty === undefined && io.stdin !== undefined) {
        return (await io.stdin()).trim();
      }
      if (prompt.type === 'manual_code') return untilAborted(prompt.signal);
      throw new Error(`pi asked what sail login cannot answer: ${prompt.message}`);
    },
    notify(event: AuthEvent) {
      if (event.type === 'auth_url') {
        io.stdout(`${COMMAND}: log in to ChatGPT in the browser:\n${event.url}\n`);
        // The browser opens only for a person at a terminal.
        if (io.tty !== undefined) Bun.spawn(['open', event.url], { stdio: ['ignore', 'ignore', 'ignore'] });
      } else if (event.type === 'device_code') {
        io.stdout(`${COMMAND}: open ${event.verificationUri} and enter ${event.userCode}\n`);
      } else {
        io.stdout(`${COMMAND}: ${event.message}\n`);
      }
    },
  };
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  try {
    const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false });
    await runtime.login(CODEX_PROVIDER, 'oauth', interaction);
  } catch (error) {
    return refuse(`the Codex login failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  io.stdout(`${COMMAND}: logged in to Codex; pi's openai-codex models use it\n`);
  return EXIT_OK;
}
