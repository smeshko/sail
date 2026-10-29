import { expect, test } from 'bun:test';
import { allowlisted, isCredential } from '../../src/engine/env-allowlist';

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
