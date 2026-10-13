// The git-worktree adapter's branch leases: keyed by origin's URL with its credentials removed, shared by every clone of
// one repository (ADR-0018). The lease file is the one `src/adapters/leases.ts` writes, found through `readLease`.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLease } from '../../../src/adapters/leases';
import { createGitWorktreeWorkspace } from '../../../src/adapters/git-worktree/index';
import { writeStatus } from '../../../src/engine/run-dir';
import { captureEvents, messageOf, portFailure, rejection } from '../../helpers/ports';
import { withTempRepo } from '../../helpers/temp-repo';

const BRANCH = 'sail/FAKE-1';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp directory by its real path, removed after the test. */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-gw-leases-')));
  dirs.push(dir);
  return dir;
}

/** A run that holds a lease: its directory with STATUS `running`, and this process's pid, which is alive. */
function holderIn(root: string, runId: string) {
  const runDir = join(root, runId);
  mkdirSync(runDir, { recursive: true });
  writeStatus(runDir, 'running');
  return { runId, runDir, pid: process.pid };
}

/** The lease files in `dir`, as text, or nothing when no lease was ever written there. */
function leaseTexts(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).map((file) => readFileSync(join(dir, file), 'utf8')) : [];
}

const ORIGIN = 'https://example.com/org/sail.git';

// STICKER: git-worktree's remote key and leases land in TASK-003. Each sticker names that task.

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ("remoteKey is origin's URL with the user and the password removed", async () => {
    await withTempRepo(async (repo) => {
      repo.git('remote', 'add', 'origin', 'https://user:s3cret@example.com/org/sail.git');
      const adapter = createGitWorktreeWorkspace({ repo: repo.dir, env: repo.env, leasesDir: tempDir() });
      expect(await adapter.remoteKey(repo.dir)).toBe(ORIGIN);
    });
  });

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('remoteKey refuses a clone with no origin, as invalid', async () => {
    await withTempRepo(async (repo) => {
      const adapter = createGitWorktreeWorkspace({ repo: repo.dir, env: repo.env, leasesDir: tempDir() });
      const error = await rejection(adapter.remoteKey(repo.dir));
      expect(portFailure(error)).toEqual({ port: 'workspace', op: 'remoteKey', code: 'invalid' });
      expect(messageOf(error)).toContain('origin');
    });
  });

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('two clones of one origin share one lease: the second is refused, naming the run that holds it', async () => {
    await withTempRepo(async (first) => {
      await withTempRepo(async (second) => {
        const origin = 'https://example.com/org/sail.git';
        first.git('remote', 'add', 'origin', origin);
        second.git('remote', 'add', 'origin', origin);
        const leases = tempDir();
        const holder = holderIn(tempDir(), 'r1');
        const a = createGitWorktreeWorkspace({ repo: first.dir, env: first.env, leasesDir: leases });
        const b = createGitWorktreeWorkspace({ repo: second.dir, env: second.env, leasesDir: leases });
        const taken = await a.lease(await a.remoteKey(first.dir), BRANCH, holder);
        const refused = await b.lease(await b.remoteKey(second.dir), BRANCH, holderIn(tempDir(), 'r2'));
        expect([taken.leased, refused.leased ? 'leased' : refused.holder.runId]).toEqual([true, 'r1']);
      });
    });
  });

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a credential in the origin URL reaches no lease file and no event, and the lease names the stripped remote', async () => {
    await withTempRepo(async (repo) => {
      const secret = 'tok_SECRET_7f3';
      repo.git('remote', 'add', 'origin', `https://user:${secret}@example.com/org/sail.git`);
      const leases = tempDir();
      const capture = captureEvents();
      const adapter = createGitWorktreeWorkspace({ repo: repo.dir, env: repo.env, leasesDir: leases, emit: capture.emit });
      await adapter.lease(await adapter.remoteKey(repo.dir), BRANCH, holderIn(tempDir(), 'r1'));
      expect({
        inLeases: leaseTexts(leases).some((text) => text.includes(secret)),
        inEvents: JSON.stringify(capture.events).includes(secret),
        remote: readLease(leases, ORIGIN, BRANCH)?.remote,
      }).toEqual({ inLeases: false, inEvents: false, remote: ORIGIN });
    });
  });
