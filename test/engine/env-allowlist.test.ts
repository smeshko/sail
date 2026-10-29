import { expect, test } from 'bun:test';
import { allowlisted, isCredential, scriptEnv } from '../../src/engine/env-allowlist';

test('script environment skips unset declarations and deduplicates set names in order', () => {
  expect(scriptEnv({ A: 'a', B: 'b' }, ['B', 'ABSENT', 'A', 'B'])).toEqual({
    env: { B: 'b', A: 'a' },
    given: ['B', 'A'],
  });
});

test('script environment excludes git config injection and toolchain variables by default', () => {
  expect(
    scriptEnv(
      {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_PARAMETERS: 'secret',
        JAVA_HOME: '/java',
        CI: '1',
        XDG_CONFIG_HOME: '/config',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
      [],
    ),
  ).toEqual({ env: { XDG_CONFIG_HOME: '/config', GIT_COMMITTER_EMAIL: 'test@example.com' }, given: [] });
});

for (const name of ['LC_ALL', 'AWS_REGION', 'PATH']) {
  test(`allowlists ${name}`, () => expect(allowlisted(name)).toBe(true));
}
for (const name of ['LINEAR_API_KEY', 'LCX']) {
  test(`does not allowlist ${name}`, () => expect(allowlisted(name)).toBe(false));
}
for (const name of [
  'GITHUB_TOKEN',
  'SAIL_GITHUB_TOKEN',
  'LINEAR_API_KEY',
  'TYPESAFE_API_KEY',
  'ANTHROPIC_BASE_URL',
  'AWS_REGION',
]) {
  test(`recognizes credential ${name}`, () => expect(isCredential(name)).toBe(true));
}
for (const name of ['PATH', 'HOME', 'SAIL_HOME']) {
  test(`does not classify ${name} as a credential`, () => expect(isCredential(name)).toBe(false));
}
