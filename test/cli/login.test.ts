// `sail login codex`, in process through run(): pi's Codex OAuth, finished from the redirect URL on stdin (stdin is not a
// terminal here), OpenAI's token endpoint answered by a stubbed fetch, and the keychain a stand-in `security`.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { untilAborted } from '../../src/cli/commands/login';
import { EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { codexJwt, fakeKeychain } from '../helpers/pi';
import { rejection } from '../helpers/ports';
import { runCaptured } from '../helpers/run-captured';

const base = mkdtempSync(join(tmpdir(), 'sail-test-login-'));
let made = 0;
afterAll(() => rmSync(base, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** OpenAI's auth endpoints, answering every request with `response`: what was sent is kept. */
function openai(response: () => Response): string[] {
  const sent: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push(`${String(url)} ${String(init?.body)}`);
    return response();
  }) as typeof fetch;
  return sent;
}

const REDIRECT = 'http://localhost:1455/auth/callback?code=the-code';

test('sail login codex prints the authorize URL, takes the redirect on stdin, and keeps the login in the keychain', async () => {
  const keychain = fakeKeychain(join(base, String(++made)));
  const access = codexJwt('acct-1');
  const sent = openai(() => Response.json({ access_token: access, refresh_token: 'refresh-1', expires_in: 3600 }));
  const before = Date.now();
  const { code, stdout, stderr } = await runCaptured(['login', 'codex'], process.cwd(), {
    env: keychain.env,
    stdin: `${REDIRECT}\n`,
  });
  const held = keychain.held() as Record<string, unknown>;
  const lines = stdout.split('\n');
  expect({
    code,
    stderr,
    first: lines[0],
    authorize: lines[1]?.startsWith('https://auth.openai.com/oauth/authorize?'),
    last: lines.at(-2),
    exchanged: sent.some((request) => request.includes('code=the-code')),
    held: { ...held, access: held.access === access, expires: Number(held.expires) >= before + 3_000_000 } as unknown,
  }).toEqual({
    code: EXIT_OK,
    stderr: '',
    first: 'sail login: log in to ChatGPT in the browser:',
    authorize: true,
    last: "sail login: logged in to Codex; pi's openai-codex models use it",
    exchanged: true,
    held: { type: 'oauth', access: true, refresh: 'refresh-1', expires: true, accountId: 'acct-1' },
  });
});

test('a code OpenAI refuses, and a keychain that refuses the login, each exit 3 naming why and keep nothing', async () => {
  const refusedCode = fakeKeychain(join(base, String(++made)));
  openai(() => new Response('bad code', { status: 400 }));
  const exchange = await runCaptured(['login', 'codex'], process.cwd(), { env: refusedCode.env, stdin: REDIRECT });

  const locked = fakeKeychain(join(base, String(++made)), { FAKE_KEYCHAIN_REFUSE: 'User interaction is not allowed.' });
  openai(() => Response.json({ access_token: codexJwt('acct-1'), refresh_token: 'r', expires_in: 3600 }));
  const keychain = await runCaptured(['login', 'codex'], process.cwd(), { env: locked.env, stdin: REDIRECT });
  expect({
    codes: [exchange.code, keychain.code],
    failed: [exchange.stderr.startsWith('sail login: the Codex login failed: '), exchange.stderr.includes('400')],
    keychain: keychain.stderr,
    held: [refusedCode.held(), locked.held()],
  }).toEqual({
    codes: [EXIT_REFUSED, EXIT_REFUSED],
    failed: [true, true],
    keychain:
      'sail login: the Codex login failed: Credential store modify failed for openai-codex: the keychain refused the Codex login: User interaction is not allowed.\n',
    held: [undefined, undefined],
  });
});

test('sail login codex --device asks OpenAI for a device code instead of opening the browser', async () => {
  const keychain = fakeKeychain(join(base, String(++made)));
  const sent = openai(() => new Response('unavailable', { status: 503 }));
  const { code, stdout } = await runCaptured(['login', 'codex', '--device'], process.cwd(), { env: keychain.env });
  expect({
    code,
    browser: stdout.includes('authorize'),
    device: sent.some((request) => request.includes('device')),
  }).toEqual({
    code: EXIT_REFUSED,
    browser: false,
    device: true,
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

test("in a terminal the pasted-code prompt never answers: it rejects once pi aborts it, as the browser's callback won", async () => {
  const controller = new AbortController();
  const waiting = untilAborted(controller.signal);
  const early = await Promise.race([waiting.then(() => 'answered'), Bun.sleep(20).then(() => 'waiting')]);
  controller.abort(new Error('callback won'));
  expect({ early, aborted: String(await rejection(waiting)) }).toEqual({
    early: 'waiting',
    aborted: 'Error: callback won',
  });
});
