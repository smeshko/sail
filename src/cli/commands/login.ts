// `sail login codex`: logs in to a ChatGPT subscription for pi's `openai-codex` models, through pi's Codex OAuth in the
// browser, and keeps the tokens in sail's own keychain item. When the browser can't reach this machine's callback, the
// redirect URL pasted on stdin finishes it. Anything but `codex` is refused with exit code 3.
import type { OAuthLoginCallbacks } from '@mariozechner/pi-ai';
import {
  accountOf,
  asCodexCredential,
  type CodexCredential,
  type CodexStore,
  keychainStore,
  systemSecurity,
} from '../../adapters/pi/codex-login';
import { EXIT_OK, type ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';
import { refuseAs } from './run-workflow';

const COMMAND = 'sail login';

export interface LoginDeps {
  /** Where the login is kept: the keychain's item when left out. */
  readonly store?: CodexStore;
  /** Opens `url` in the browser: `open` when stdout is a terminal, nothing otherwise. */
  readonly open?: (url: string) => void;
}

/** pi's Codex OAuth: its browser flow, and the code pasted when the callback never comes. */
async function piLogin(callbacks: OAuthLoginCallbacks): Promise<CodexCredential> {
  const { loginOpenAICodex } = await import('@mariozechner/pi-ai/oauth');
  // pi's Codex OAuth loads node:crypto and node:http itself, after its import: a login that starts first is refused.
  await Promise.all([import('node:crypto'), import('node:http')]);
  await Bun.sleep(0);
  return asCodexCredential(await loginOpenAICodex({ onAuth: callbacks.onAuth, onPrompt: callbacks.onPrompt }));
}

export async function login(args: Parsed, io: Io, deps: LoginDeps = {}): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  const [provider] = args.positionals;
  if (provider !== 'codex')
    return refuse(
      provider === undefined ? 'name what to log in to: codex' : `no login for '${provider}': codex is the one`,
    );
  const env = io.env ?? process.env;
  const store = deps.store ?? keychainStore(accountOf(env), systemSecurity(env));
  const open =
    deps.open ??
    ((url: string) => {
      if (io.tty !== undefined) Bun.spawn(['open', url], { stdio: ['ignore', 'ignore', 'ignore'] });
    });
  let credential: CodexCredential;
  try {
    credential = await piLogin({
      onAuth: ({ url }) => {
        io.stdout(`${COMMAND}: log in to ChatGPT in the browser:\n${url}\n`);
        open(url);
      },
      onPrompt: async ({ message }) => {
        io.stdout(`${message} (then Ctrl-D)\n`);
        return (await io.stdin?.()) ?? '';
      },
    });
  } catch (error) {
    return refuse(`the Codex login failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await store.write(credential);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
  io.stdout(`${COMMAND}: logged in to Codex; pi's openai-codex models use it\n`);
  return EXIT_OK;
}
