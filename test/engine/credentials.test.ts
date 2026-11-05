// The credential sources: an unset variable an adapter requires is read from a fixed keychain item or from `gh auth
// token`, through injected stand-ins for `security` and `gh`, so nothing here reaches the real keychain.
import { expect, test } from 'bun:test';
import { type CommandEnd, fillCredentials, systemCredentials } from '../../src/engine/credentials';
import type { Security, SecurityEnd } from '../../src/engine/keychain';

const end = (stdout: string, exitCode = 0, stderr = ''): SecurityEnd => ({ exitCode, stdout, stderr });

/** A `security` answering by item, which records the arguments it was called with. */
function keychain(items: Record<string, SecurityEnd>): { security: Security; calls: string[][] } {
  const calls: string[][] = [];
  const security: Security = async (args) => {
    calls.push([...args]);
    return items[args[2] as string] ?? end('', 44);
  };
  return { security, calls };
}

const ON = { SAIL_CREDENTIAL_LOOKUP: 'on' };

test('a variable that is set is never looked up', async () => {
  const { security, calls } = keychain({ 'linear-api-key': end('from-keychain\n') });
  const lookup = systemCredentials(ON, { security });
  const result = await fillCredentials(['LINEAR_API_KEY'], { LINEAR_API_KEY: 'from-env' }, lookup);
  expect(result).toEqual({ filled: {}, tried: {}, errors: [] });
  expect(calls).toEqual([]);
});

test('an unset LINEAR_API_KEY is filled from its keychain item, trimmed', async () => {
  const { security, calls } = keychain({ 'linear-api-key': end('lin_key_123\n') });
  const lookup = systemCredentials(ON, { security });
  const result = await fillCredentials(['LINEAR_API_KEY'], { LINEAR_API_KEY: '' }, lookup);
  expect(result.filled).toEqual({ LINEAR_API_KEY: 'lin_key_123' });
  expect(calls).toEqual([['find-generic-password', '-s', 'linear-api-key', '-w']]);
});

test('with both of ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN unset, the token is filled from claude-oauth-token', async () => {
  const { security } = keychain({ 'claude-oauth-token': end('oauth-abc\n') });
  const lookup = systemCredentials(ON, { security });
  const result = await fillCredentials([['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']], {}, lookup);
  expect(result.filled).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-abc' });
});

test('with ANTHROPIC_API_KEY set, the group asks for nothing', async () => {
  const { security, calls } = keychain({ 'claude-oauth-token': end('oauth-abc\n') });
  const lookup = systemCredentials(ON, { security });
  const result = await fillCredentials(
    [['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']],
    { ANTHROPIC_API_KEY: 'sk-x' },
    lookup,
  );
  expect(result.filled).toEqual({});
  expect(calls).toEqual([]);
});

test('GITHUB_TOKEN is filled from a gh that prints a token', async () => {
  const argvs: (readonly string[])[] = [];
  const run = async (argv: readonly string[]): Promise<CommandEnd> => {
    argvs.push(argv);
    return { exitCode: 0, stdout: 'gho_token\n', stderr: '' };
  };
  const lookup = systemCredentials(ON, { run });
  const result = await fillCredentials([['SAIL_GITHUB_TOKEN', 'GITHUB_TOKEN']], {}, lookup);
  expect(result.filled).toEqual({ GITHUB_TOKEN: 'gho_token' });
  expect(argvs).toEqual([['gh', 'auth', 'token']]);
});

test('a gh that exits 1 gives unset naming gh auth token', async () => {
  const run = async (): Promise<CommandEnd> => ({ exitCode: 1, stdout: '', stderr: 'not logged in' });
  expect(await systemCredentials(ON, { run })('GITHUB_TOKEN')).toEqual({ unset: 'gh auth token gave none' });
  const result = await fillCredentials([['SAIL_GITHUB_TOKEN', 'GITHUB_TOKEN']], {}, systemCredentials(ON, { run }));
  expect(result.tried).toEqual({ 'SAIL_GITHUB_TOKEN,GITHUB_TOKEN': 'gh auth token gave none' });
});

test('a gh absent from the PATH gives unset naming gh auth token', async () => {
  const lookup = systemCredentials({ ...ON, PATH: '/nonexistent-dir-for-sail-test' });
  expect(await lookup('GITHUB_TOKEN')).toEqual({ unset: 'gh auth token gave none' });
});

test('a keychain without the item (exit 44) gives unset naming the item', async () => {
  const { security } = keychain({});
  expect(await systemCredentials(ON, { security })('LINEAR_API_KEY')).toEqual({
    unset: 'the keychain holds no linear-api-key item',
  });
});

test('a missing security program gives unset naming the item', async () => {
  const lookup = systemCredentials({ ...ON, PATH: '/nonexistent-dir-for-sail-test' });
  expect(await lookup('TYPESAFE_API_KEY')).toEqual({ unset: 'the keychain holds no typesafe-api-key item' });
});

test('a keychain that refuses the item (exit 51) gives an error naming the item and the stderr', async () => {
  const { security } = keychain({ 'linear-api-key': end('', 51, 'User interaction is not allowed.\n') });
  const lookup = systemCredentials(ON, { security });
  expect(await lookup('LINEAR_API_KEY')).toEqual({
    error: 'the keychain refused its linear-api-key item: User interaction is not allowed.',
  });
  const result = await fillCredentials(['LINEAR_API_KEY'], {}, systemCredentials(ON, { security }));
  expect(result.errors).toEqual([
    'LINEAR_API_KEY: the keychain refused its linear-api-key item: User interaction is not allowed.',
  ]);
});

test('a source that does not answer within the timeout gives an error saying so', async () => {
  const security: Security = () => new Promise(() => {});
  const run = (_argv: readonly string[], _env: unknown, signal: AbortSignal) =>
    new Promise<CommandEnd>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const lookup = systemCredentials(ON, { security, run, timeoutMs: 20 });
  expect(await lookup('LINEAR_API_KEY')).toEqual({
    error: 'the keychain did not answer within 0.02 s for its linear-api-key item',
  });
  expect(await lookup('GITHUB_TOKEN')).toEqual({ error: 'gh auth token did not answer within 0.02 s' });
});

test('a name with no source is not looked up and stays unfilled', async () => {
  const { security, calls } = keychain({});
  const run = async (): Promise<CommandEnd> => ({ exitCode: 0, stdout: 'x', stderr: '' });
  const result = await fillCredentials(['ECHO_HARNESS_TOKEN'], {}, systemCredentials(ON, { security, run }));
  expect(result).toEqual({ filled: {}, tried: {}, errors: [] });
  expect(calls).toEqual([]);
});

test('SAIL_CREDENTIAL_LOOKUP=off in the env asks nothing', async () => {
  const { security, calls } = keychain({ 'linear-api-key': end('k\n') });
  const result = await fillCredentials(
    ['LINEAR_API_KEY'],
    {},
    systemCredentials({ SAIL_CREDENTIAL_LOOKUP: 'off' }, { security }),
  );
  expect(result).toEqual({ filled: {}, tried: {}, errors: [] });
  expect(calls).toEqual([]);
});

test('without the switch in the env, process.env decides: the launcher sets it off', async () => {
  expect(process.env.SAIL_CREDENTIAL_LOOKUP).toBe('off');
  const { security, calls } = keychain({ 'linear-api-key': end('k\n') });
  const result = await fillCredentials(['LINEAR_API_KEY'], {}, systemCredentials({}, { security }));
  expect(result.filled).toEqual({});
  expect(calls).toEqual([]);
});

test('a name is asked once however often it is looked up', async () => {
  const { security, calls } = keychain({ 'linear-api-key': end('k\n') });
  const lookup = systemCredentials(ON, { security });
  await lookup('LINEAR_API_KEY');
  await lookup('LINEAR_API_KEY');
  expect(calls.length).toBe(1);
});
