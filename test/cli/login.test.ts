// `sail login codex`, in process through run(): pi's Codex OAuth with its callback port taken, so the login finishes from
// the redirect URL on stdin, OpenAI's token endpoint answered by a stubbed fetch, and the keychain a stand-in `security`.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { codexJwt, fakeKeychain } from '../helpers/pi';
import { runCaptured } from '../helpers/run-captured';

const base = mkdtempSync(join(tmpdir(), 'sail-test-login-'));
let made = 0;

// pi's callback server can't listen while this holds its port, so every login here asks for the pasted URL.
let holder: Server<undefined> | undefined;
beforeAll(() => {
  try {
    holder = Bun.serve({ hostname: '127.0.0.1', port: 1455, fetch: () => new Response('') });
  } catch {
    // Something else holds it: pi's server can't listen either.
  }
});
afterAll(() => {
  holder?.stop(true);
  rmSync(base, { recursive: true, force: true });
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** OpenAI's token endpoint, answering every exchange with `response`. */
function tokenEndpoint(response: () => Response): string[] {
  const sent: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push(`${String(url)} ${String(init?.body)}`);
    return response();
  }) as typeof fetch;
  return sent;
}

const REDIRECT = 'http://localhost:1455/auth/callback?code=the-code';

test('sail login codex prints the authorize URL, takes the pasted redirect, and keeps the login in the keychain', async () => {
  const keychain = fakeKeychain(join(base, String(++made)));
  const access = codexJwt('acct-1');
  const sent = tokenEndpoint(() =>
    Response.json({ access_token: access, refresh_token: 'refresh-1', expires_in: 3600 }),
  );
  const before = Date.now();
  const { code, stdout, stderr } = await runCaptured(['login', 'codex'], process.cwd(), {
    env: keychain.env,
    stdin: REDIRECT,
  });
  const held = keychain.held() as { access: string; refresh: string; expires: number; accountId: string };
  const lines = stdout.split('\n');
  expect({
    code,
    stderr,
    first: lines[0],
    authorize: lines[1]?.startsWith('https://auth.openai.com/oauth/authorize?'),
    pasted: lines[2],
    last: lines[3],
    exchanged: sent.length === 1 && sent[0]?.includes('code=the-code'),
    held: { ...held, access: held.access === access, expires: held.expires >= before + 3_600_000 },
  }).toEqual({
    code: EXIT_OK,
    stderr: '',
    first: 'sail login: log in to ChatGPT in the browser:',
    authorize: true,
    pasted: 'Paste the authorization code (or full redirect URL): (then Ctrl-D)',
    last: "sail login: logged in to Codex; pi's openai-codex models use it",
    exchanged: true,
    held: { access: true, refresh: 'refresh-1', expires: true, accountId: 'acct-1' },
  });
});

test('a code OpenAI refuses, and a keychain that refuses the login, each exit 3 naming why and keep nothing', async () => {
  const refusedCode = fakeKeychain(join(base, String(++made)));
  tokenEndpoint(() => new Response('bad code', { status: 400 }));
  const exchange = await runCaptured(['login', 'codex'], process.cwd(), { env: refusedCode.env, stdin: REDIRECT });

  const locked = fakeKeychain(join(base, String(++made)), { FAKE_KEYCHAIN_REFUSE: 'User interaction is not allowed.' });
  tokenEndpoint(() => Response.json({ access_token: codexJwt('acct-1'), refresh_token: 'r', expires_in: 3600 }));
  const keychain = await runCaptured(['login', 'codex'], process.cwd(), { env: locked.env, stdin: REDIRECT });
  expect({
    codes: [exchange.code, keychain.code],
    stderr: [exchange.stderr, keychain.stderr],
    held: [refusedCode.held(), locked.held()],
  }).toEqual({
    codes: [EXIT_REFUSED, EXIT_REFUSED],
    stderr: [
      'sail login: the Codex login failed: OpenAI Codex token exchange failed (400): bad code\n',
      'sail login: the keychain refused the Codex login: User interaction is not allowed.\n',
    ],
    held: [undefined, undefined],
  });
});

test('sail login with nothing, or with anything but codex, exits 3 naming codex', async () => {
  const none = await runCaptured(['login']);
  const other = await runCaptured(['login', 'claude']);
  expect([none.code, none.stderr, other.code, other.stderr]).toEqual([
    EXIT_REFUSED,
    'sail login: name what to log in to: codex\n',
    EXIT_REFUSED,
    "sail login: no login for 'claude': codex is the one\n",
  ]);
});
