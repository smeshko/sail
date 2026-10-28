// The Codex login: the keychain item through a stand-in `security` on the PATH, the lock file, and when the access token
// is refreshed. Nothing here reaches the real keychain or OpenAI: pi's refresh is answered by a stubbed fetch.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  accountOf,
  type CodexCredential,
  type CodexStore,
  codexAccessToken,
  KEYCHAIN_SERVICE,
  keychainCodexLogin,
  keychainStore,
  NO_LOGIN,
  REFRESH_MARGIN_MS,
  refreshWithPi,
  type Security,
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

const LOGIN: CodexCredential = { access: 'access-1', refresh: 'refresh-1', expires: 1_000_000_000, accountId: 'acct' };

function memoryStore(initial?: CodexCredential): CodexStore & { writes: CodexCredential[] } {
  let held = initial;
  const writes: CodexCredential[] = [];
  return {
    writes,
    read: async () => held,
    async write(credential) {
      writes.push(credential);
      held = credential;
    },
  };
}

test('the keychain store reads none, a login, and refuses what is not one or what security refuses', async () => {
  const answers: Record<string, Awaited<ReturnType<Security>>> = {
    none: { exitCode: 44, stdout: '', stderr: 'could not be found' },
    login: { exitCode: 0, stdout: `${JSON.stringify(LOGIN)}\n`, stderr: '' },
    junk: { exitCode: 0, stdout: 'not json\n', stderr: '' },
    partial: { exitCode: 0, stdout: '{"access":"a"}\n', stderr: '' },
    locked: { exitCode: 51, stdout: '', stderr: 'User interaction is not allowed.\n' },
  };
  const read = (name: string) =>
    keychainStore('ivo', async () => answers[name] as Awaited<ReturnType<Security>>).read();
  expect({
    none: await read('none'),
    login: await read('login'),
    junk: String(await rejection(read('junk'))),
    partial: String(await rejection(read('partial'))),
    locked: String(await rejection(read('locked'))),
  }).toEqual({
    none: undefined,
    login: LOGIN,
    junk: `Error: the keychain's ${KEYCHAIN_SERVICE} item is not a Codex login: run sail login codex`,
    partial: `Error: the keychain's ${KEYCHAIN_SERVICE} item is not a Codex login: run sail login codex`,
    locked: 'Error: the keychain refused the Codex login: User interaction is not allowed.',
  });
});

test("the keychain store writes the user's sail-openai-codex item, replacing it, and names a refusal", async () => {
  const calls: (readonly string[])[] = [];
  const ok = keychainStore('ivo', async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  await ok.write(LOGIN);
  const refusing = keychainStore('ivo', async () => ({ exitCode: 45, stdout: '', stderr: 'duplicate item\n' }));
  expect({ calls, refused: String(await rejection(refusing.write(LOGIN))) }).toEqual({
    calls: [
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
    refused: 'Error: the keychain refused the Codex login: duplicate item',
  });
});

test("a login written through the PATH's security reads back the same", async () => {
  const keychain = fakeKeychain(fresh());
  const store = keychainStore('ivo', systemSecurity(keychain.env));
  const before = await store.read();
  await store.write(LOGIN);
  expect({ before, after: await store.read() }).toEqual({ before: undefined, after: LOGIN });
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
  const stale = join(dir, 'stale.lock');
  const dead = Bun.spawnSync(['/bin/sh', '-c', 'echo $$']).stdout.toString().trim();
  mkdirSync(dir, { recursive: true });
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

test('an access token with more than five minutes left is used as it is', async () => {
  const store = memoryStore(LOGIN);
  let refreshed = 0;
  const token = await codexAccessToken({
    store,
    lockFile: join(fresh(), 'codex.lock'),
    now: () => LOGIN.expires - REFRESH_MARGIN_MS - 1,
    refresh: async () => {
      refreshed++;
      return LOGIN;
    },
  });
  expect({ token, refreshed, writes: store.writes }).toEqual({ token: 'access-1', refreshed: 0, writes: [] });
});

test('one with five minutes or less is refreshed once, and the new pair is kept, however many sessions ask', async () => {
  const store = memoryStore(LOGIN);
  const next: CodexCredential = {
    access: 'access-2',
    refresh: 'refresh-2',
    expires: LOGIN.expires + 3_600_000,
    accountId: 'acct',
  };
  const spent: string[] = [];
  const login = {
    store,
    lockFile: join(fresh(), 'codex.lock'),
    now: () => LOGIN.expires - REFRESH_MARGIN_MS,
    lock: { pollMs: 5 },
    refresh: async (token: string) => {
      spent.push(token);
      await Bun.sleep(20);
      return next;
    },
  };
  const tokens = await Promise.all([codexAccessToken(login), codexAccessToken(login), codexAccessToken(login)]);
  expect({ tokens, spent, writes: store.writes }).toEqual({
    tokens: ['access-2', 'access-2', 'access-2'],
    spent: ['refresh-1'],
    writes: [next],
  });
});

test('no login, one gone while waiting on the lock, and a refresh that fails each tell to run sail login codex', async () => {
  const lockFile = join(fresh(), 'codex.lock');
  const stale = { now: () => LOGIN.expires, lockFile };
  const none = await rejection(codexAccessToken({ ...stale, store: memoryStore(), refresh: async () => LOGIN }));
  let reads = 0;
  const vanishing: CodexStore = {
    read: async () => (reads++ === 0 ? LOGIN : undefined),
    write: async () => undefined,
  };
  const gone = await rejection(codexAccessToken({ ...stale, store: vanishing, refresh: async () => LOGIN }));
  const failing = await rejection(
    codexAccessToken({
      ...stale,
      store: memoryStore(LOGIN),
      refresh: async () => {
        throw new Error('invalid_grant');
      },
    }),
  );
  expect([String(none), String(gone), String(failing)]).toEqual([
    `Error: ${NO_LOGIN}`,
    `Error: ${NO_LOGIN}`,
    'Error: the Codex login could not be refreshed (invalid_grant): run sail login codex',
  ]);
});

test("pi's refresh trades the refresh token at OpenAI for a new login with the token's account", async () => {
  const sent: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push(`${String(url)} ${String(init?.body)}`);
    return Response.json({ access_token: codexJwt('acct-9'), refresh_token: 'refresh-9', expires_in: 3600 });
  }) as typeof fetch;
  const before = Date.now();
  const login = await refreshWithPi('refresh-1');
  expect({
    access: login.access === codexJwt('acct-9'),
    refresh: login.refresh,
    accountId: login.accountId,
    expiresInAnHour: login.expires >= before + 3_600_000,
    grant: sent[0]?.startsWith('https://auth.openai.com/oauth/token '),
    spent: sent[0]?.includes('refresh_token=refresh-1'),
  }).toEqual({
    access: true,
    refresh: 'refresh-9',
    accountId: 'acct-9',
    expiresInAnHour: true,
    grant: true,
    spent: true,
  });
});

test("the keychain login reads the user's item through the PATH's security and locks under ~/.sail/locks", async () => {
  const keychain = fakeKeychain(fresh());
  keychain.hold({ ...LOGIN, expires: Date.now() + 3_600_000 });
  const login = keychainCodexLogin(keychain.env);
  expect({
    token: await codexAccessToken(login),
    lockFile: login.lockFile,
    asked: keychain.calls()[0],
  }).toEqual({
    token: 'access-1',
    lockFile: join(homedir(), '.sail', 'locks', 'openai-codex.lock'),
    asked: `find-generic-password -a ivo -s ${KEYCHAIN_SERVICE} -w`,
  });
});
