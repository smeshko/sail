// The Codex login: the keychain item as pi's credential store, through a stand-in `security`, the lock file its writes
// hold, and pi's own refresh run through it. Nothing here reaches the real keychain or OpenAI: the token endpoint is a
// stubbed fetch.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Credential } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  accountOf,
  KEYCHAIN_SERVICE,
  keychainStore,
  type Security,
  type SecurityEnd,
  systemSecurity,
  withLock,
} from '../../../src/adapters/pi/codex-login';
import { codexJwt, fakeKeychain } from '../../helpers/pi';
import { rejection } from '../../helpers/ports';

const base = mkdtempSync(join(tmpdir(), 'sail-test-codex-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let made = 0;
const fresh = () => join(base, String(++made));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const LOGIN: Credential = { type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 1_000_000_000 };
const ok = (stdout = ''): SecurityEnd => ({ exitCode: 0, stdout, stderr: '' });

/** A keychain store over `security`, its lock `lockFile`: one in a fresh directory unless named. */
const storeOver = (security: Security, lockFile = join(fresh(), 'codex.lock')) =>
  keychainStore({ account: 'ivo', security, lockFile, lock: { pollMs: 5 } });

test("the store reads none, the login, nothing for another provider, and refuses what isn't a login or what security refuses", async () => {
  const answers: Record<string, SecurityEnd> = {
    none: { exitCode: 44, stdout: '', stderr: 'could not be found' },
    login: ok(`${JSON.stringify({ ...LOGIN, accountId: 'acct' })}\n`),
    junk: ok('not json\n'),
    apiKey: ok('{"type":"api_key","key":"k"}\n'),
    locked: { exitCode: 51, stdout: '', stderr: 'User interaction is not allowed.\n' },
  };
  const read = (name: string, provider = 'openai-codex') =>
    storeOver(async () => answers[name] as SecurityEnd).read(provider);
  const notALogin = `Error: the keychain's ${KEYCHAIN_SERVICE} item is not a Codex login: run sail login codex`;
  expect({
    none: await read('none'),
    login: await read('login'),
    other: await read('login', 'anthropic'),
    junk: String(await rejection(read('junk'))),
    apiKey: String(await rejection(read('apiKey'))),
    locked: String(await rejection(read('locked'))),
  }).toEqual({
    none: undefined,
    login: { ...LOGIN, accountId: 'acct' },
    other: undefined,
    junk: notALogin,
    apiKey: notALogin,
    locked: 'Error: the keychain refused the Codex login: User interaction is not allowed.',
  });
});

test("modify writes the user's sail-openai-codex item, replacing it; undefined leaves it; another provider is refused", async () => {
  const calls: (readonly string[])[] = [];
  let held: Credential | undefined;
  const store = storeOver(async (args) => {
    calls.push(args);
    if (args[0] === 'find-generic-password') {
      return held === undefined ? { exitCode: 44, stdout: '', stderr: '' } : ok(JSON.stringify(held));
    }
    held = JSON.parse(args.at(-1) as string);
    return ok();
  });
  const written = await store.modify('openai-codex', async () => LOGIN);
  const kept = await store.modify('openai-codex', async () => undefined);
  const other = await rejection(store.modify('anthropic', async () => LOGIN));
  expect({
    written,
    kept,
    other: String(other),
    writes: calls.filter((call) => call[0] === 'add-generic-password'),
  }).toEqual({
    written: LOGIN,
    kept: LOGIN,
    other: "Error: the keychain holds the Codex login, not anthropic's",
    writes: [
      [
        'add-generic-password',
        '-U',
        '-a',
        'ivo',
        '-s',
        'sail-openai-codex',
        '-l',
        'sail: Codex login',
        '-w',
        JSON.stringify(LOGIN),
      ],
    ],
  });
});

test("a write security refuses rejects modify, naming security's message", async () => {
  const store = storeOver(async (args) =>
    args[0] === 'find-generic-password'
      ? { exitCode: 44, stdout: '', stderr: '' }
      : { exitCode: 45, stdout: '', stderr: 'duplicate item\n' },
  );
  expect(String(await rejection(store.modify('openai-codex', async () => LOGIN)))).toBe(
    'Error: the keychain refused the Codex login: duplicate item',
  );
});

test('through the PATH security a login is listed, read back, deleted, and deleting none is no error', async () => {
  const keychain = fakeKeychain(fresh());
  const store = storeOver(systemSecurity(keychain.env));
  const before = await store.list();
  await store.modify('openai-codex', async () => LOGIN);
  const listed = await store.list();
  const read = await store.read('openai-codex');
  await store.delete('openai-codex');
  await store.delete('openai-codex');
  const refused = await rejection(store.delete('anthropic'));
  expect({ before, listed, read, after: keychain.held(), refused: String(refused) }).toEqual({
    before: [],
    listed: [{ providerId: 'openai-codex', type: 'oauth' }],
    read: LOGIN,
    after: undefined,
    refused: "Error: the keychain holds the Codex login, not anthropic's",
  });
});

test('a delete security refuses rejects, naming its message', async () => {
  const store = storeOver(async () => ({ exitCode: 51, stdout: '', stderr: 'User interaction is not allowed.\n' }));
  expect(String(await rejection(store.delete('openai-codex')))).toBe(
    'Error: the keychain refused the Codex login: User interaction is not allowed.',
  );
});

test('the account is $USER, or the login name when it is unset', () => {
  expect({ set: accountOf({ USER: 'ivo' }), unset: accountOf({}) }).toEqual({ set: 'ivo', unset: userInfo().username });
});

test('a lock is held by one at a time: the second waits for the first to let go', async () => {
  const file = join(fresh(), 'codex.lock');
  const order: string[] = [];
  let release: () => void = () => undefined;
  const first = withLock(file, async () => {
    order.push('first in');
    await new Promise<void>((done) => {
      release = done;
    });
    order.push('first out');
  });
  await Bun.sleep(20);
  const second = withLock(
    file,
    async () => {
      order.push('second in');
    },
    { pollMs: 5 },
  );
  await Bun.sleep(50);
  order.push('released');
  release();
  await Promise.all([first, second]);
  expect({ order, left: existsSync(file) }).toEqual({
    order: ['first in', 'released', 'first out', 'second in'],
    left: false,
  });
});

test("a lock whose holder is dead is taken; a live holder's is refused after the wait, naming it", async () => {
  const dir = fresh();
  mkdirSync(dir, { recursive: true });
  const stale = join(dir, 'stale.lock');
  const dead = Bun.spawnSync(['/bin/sh', '-c', 'echo $$']).stdout.toString().trim();
  writeFileSync(stale, `${dead}\n`);
  const took = await withLock(stale, async () => 'took');
  const live = join(dir, 'live.lock');
  writeFileSync(live, `${process.pid}\n`);
  const refused = await rejection(withLock(live, async () => 'never', { waitMs: 30, pollMs: 5 }));
  expect({ took, refused: String(refused), kept: readFileSync(live, 'utf8') }).toEqual({
    took: 'took',
    refused: `Error: the Codex login stayed locked by pid ${process.pid}: ${live}`,
    kept: `${process.pid}\n`,
  });
});

/** OpenAI's token endpoint, answering each refresh with a new pair: the refresh tokens it was sent are kept. */
function tokenEndpoint(): string[] {
  const spent: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const token = new URLSearchParams(String(init?.body)).get('refresh_token') ?? '';
    spent.push(token);
    await Bun.sleep(20);
    return Response.json({
      access_token: codexJwt(`acct-${spent.length}`),
      refresh_token: `refresh-${spent.length + 1}`,
      expires_in: 3600,
    });
  }) as typeof fetch;
  return spent;
}

/** pi's model runtime over the keychain login in `keychain`, locked by `lockFile`. */
const runtimeOver = (keychain: ReturnType<typeof fakeKeychain>, lockFile: string) =>
  ModelRuntime.create({
    credentials: storeOver(systemSecurity(keychain.env), lockFile),
    modelsPath: null,
    refreshOnCreate: false,
  });

test('pi uses an access token with more than five minutes left as it is', async () => {
  const keychain = fakeKeychain(fresh());
  const access = codexJwt('acct');
  keychain.hold({ type: 'oauth', access, refresh: 'refresh-1', expires: Date.now() + 10 * 60_000, accountId: 'acct' });
  const spent = tokenEndpoint();
  const auth = await (await runtimeOver(keychain, join(fresh(), 'codex.lock'))).getAuth('openai-codex');
  expect({ key: auth?.auth.apiKey === access, spent }).toEqual({ key: true, spent: [] });
});

test('pi refreshes one with under five minutes left once, however many sessions ask, and the keychain keeps the new pair', async () => {
  const keychain = fakeKeychain(fresh());
  keychain.hold({
    type: 'oauth',
    access: codexJwt('acct'),
    refresh: 'refresh-1',
    expires: Date.now() + 4 * 60_000,
    accountId: 'acct',
  });
  const spent = tokenEndpoint();
  // Three runtimes, as three processes would have: each has its own view, and only the lock file is shared.
  const lockFile = join(fresh(), 'codex.lock');
  const runtimes = await Promise.all([1, 2, 3].map(() => runtimeOver(keychain, lockFile)));
  const auths = await Promise.all(runtimes.map((runtime) => runtime.getAuth('openai-codex')));
  const held = keychain.held() as { access: string; refresh: string };
  expect({
    spent,
    keys: auths.map((auth) => auth?.auth.apiKey === codexJwt('acct-1')),
    held: { access: held.access === codexJwt('acct-1'), refresh: held.refresh },
  }).toEqual({ spent: ['refresh-1'], keys: [true, true, true], held: { access: true, refresh: 'refresh-2' } });
});
