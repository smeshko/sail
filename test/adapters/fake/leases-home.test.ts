// The fake workspace's leases live under the HOME its environment names, not the process's: a run's environment is its
// repository's, so the leases of one repository's runs stay apart from another's (TASK-006). Without this, every run in one
// test process would share `~/.sail/leases`.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAdapters } from '../../../src/adapters/fake/definitions';
import { readLease } from '../../../src/adapters/leases';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-fake-home-'));
  dirs.push(dir);
  return dir;
}

// STICKER: the environment-keyed lease directory lands in TASK-006.

test("the fake's leases live under the HOME its environment names, not the process's", async () => {
  const root = tempDir();
  const home = tempDir();
  const workspace = await fakeAdapters.workspace.create(
    {},
    { root, sailDir: join(root, '.sail'), runsDir: join(root, '.sail-runs'), env: { HOME: home } },
  );
  await workspace.lease('fake', 'sail/FAKE-1', {
    runId: 'r1',
    runDir: join(root, '.sail-runs', 'r1'),
    pid: process.pid,
  });
  expect(readLease(join(home, '.sail', 'leases'), 'fake', 'sail/FAKE-1')?.runId).toBe('r1');
});
