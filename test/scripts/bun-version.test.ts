// scripts/bun-version.ts warns when the Bun running verify or gate is not the one CI's verify workflow pins: CI runs on
// the pin, and a failure only that Bun shows used to surface after review.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunVersionWarning, checkBunVersion, pinnedBunVersion } from '../../scripts/bun-version';

const CHECKOUT = join(import.meta.dir, '..', '..');
const WORKFLOW = join(CHECKOUT, '.github', 'workflows', 'verify.yml');

test("reads the Bun version CI's verify pins", () => {
  expect(pinnedBunVersion(readFileSync(WORKFLOW, 'utf8'))).toMatch(/^\d+\.\d+\.\d+/);
  expect(pinnedBunVersion("        with:\n          bun-version: '1.3.14'\n")).toBe('1.3.14');
  expect(pinnedBunVersion('        with:\n          bun-version: 1.4.2 # pin\n')).toBe('1.4.2');
  expect(pinnedBunVersion('steps:\n  - uses: actions/checkout@v4\n')).toBeUndefined();
});

test('warns only when the running Bun differs from the pin', () => {
  const warning = bunVersionWarning('1.3.14', '1.4.2');
  expect(warning).toBe(
    "bun-version: this is Bun 1.4.2, and CI's verify pins Bun 1.3.14 (.github/workflows/verify.yml). Run the check on CI's Bun: SAIL_FULL_SUITE=1 bunx bun@1.3.14 run verify",
  );
  expect(bunVersionWarning('1.4.2', '1.4.2')).toBeUndefined();
  expect(bunVersionWarning(undefined, '1.4.2')).toBeUndefined();
});

test('a checkout without the workflow is silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bun-version-'));
  try {
    expect(checkBunVersion(join(dir, 'missing.yml'), '1.4.2')).toBeUndefined();
    const file = join(dir, 'verify.yml');
    writeFileSync(file, 'with:\n  bun-version: 0.0.1\n');
    expect(checkBunVersion(file, '1.4.2')).toBe(bunVersionWarning('0.0.1', '1.4.2'));
    expect(checkBunVersion(file, '0.0.1')).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the script exits 0 and warns exactly when this Bun is not the pin', () => {
  const pin = pinnedBunVersion(readFileSync(WORKFLOW, 'utf8'));
  const proc = Bun.spawnSync([process.execPath, join(CHECKOUT, 'scripts', 'bun-version.ts')]);
  const warning = bunVersionWarning(pin, Bun.version);
  expect(proc.exitCode).toBe(0);
  expect(proc.stderr.toString()).toBe(warning === undefined ? '' : `${warning}\n`);
});

test('verify and gate check the Bun version first', () => {
  const scripts = JSON.parse(readFileSync(join(CHECKOUT, 'package.json'), 'utf8')).scripts;
  expect(scripts.verify.startsWith('bun scripts/bun-version.ts && ')).toBe(true);
  expect(scripts.gate.startsWith('bun scripts/bun-version.ts && ')).toBe(true);
});
