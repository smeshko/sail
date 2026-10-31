import { expect, test } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  newerSailRefusal,
  parseNewerSail,
  SDK_DIR,
  sailPackageName,
  sdkFingerprint,
} from '../../src/engine/sdk-version';
import { withTempRepo } from '../helpers/temp-repo';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

test('parseNewerSail gives back the first 7 of the sha and the clone newerSailRefusal was given', () => {
  const message = newerSailRefusal(SHA, '/work/my clone');
  expect(message).toBe('definitions at abcdef0 need a newer sail: pull /work/my clone');
  expect(parseNewerSail(message)).toEqual({ sha7: 'abcdef0', clone: '/work/my clone' });
});

test('parseNewerSail reads nothing into a type-error refusal or any other line', () => {
  expect(parseNewerSail('2 type errors in .sail/workflows/a/workflow.ts (in the .sail/ committed at abcdef0)')).toBe(
    undefined,
  );
  expect(parseNewerSail('definitions at abcdef0 need a newer sail')).toBe(undefined);
  expect(parseNewerSail('')).toBe(undefined);
});

test('sdkFingerprint is the same for a copy of the declarations and changes with one byte of one file', async () => {
  await withTempRepo(async (repo) => {
    const copy = join(repo.dir, 'types');
    cpSync(SDK_DIR, copy, { recursive: true });
    const before = sdkFingerprint();
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(sdkFingerprint(copy)).toBe(before);
    writeFileSync(join(copy, 'index.d.ts'), `${readFileSync(join(copy, 'index.d.ts'), 'utf8')}// x\n`);
    expect(sdkFingerprint(copy)).not.toBe(before);
  });
});

test('sdkFingerprint tells apart the same bytes under another file name', async () => {
  await withTempRepo(async (repo) => {
    const one = join(repo.dir, 'one');
    const two = join(repo.dir, 'two');
    cpSync(SDK_DIR, one, { recursive: true });
    cpSync(SDK_DIR, two, { recursive: true });
    writeFileSync(join(one, 'a.d.ts'), 'x');
    writeFileSync(join(two, 'b.d.ts'), 'x');
    expect(sdkFingerprint(one)).not.toBe(sdkFingerprint(two));
  });
});

test("sailPackageName is the package.json's name", () => {
  expect(sailPackageName()).toBe('@smeshko/sail');
});
