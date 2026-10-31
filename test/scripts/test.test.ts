// scripts/test.ts, inside a sail run, makes a broad test run wait for the machine's gate lock, which validate holds.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const ROOT = join(import.meta.dir, '../..');
const LAUNCHER = join(ROOT, 'scripts/test.ts');
const MODULE = join(ROOT, '.sail/lib/gate-lock.mjs');
const probes = (count: number) => Array.from({ length: count }, (_, at) => `./test/lock-probe-${at}.test.ts`);

function lockDir(repo: TempRepo): string {
  const dir = join(repo.home, 'tmp');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'sail-validate.lock');
}

/** A process that holds the lock until `release` appears. Its holder file says its workspace is `repo.dir`. */
async function hold(repo: TempRepo, extra = '') {
  const release = join(repo.home, 'release');
  lockDir(repo);
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { lock } from ${JSON.stringify(MODULE)};
await lock({ label: 'holder', waiting: () => 'x' });
console.log('held');
${extra}
while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(50);`,
    ],
    { cwd: repo.dir, env: { ...repo.env, TMPDIR: join(repo.home, 'tmp') }, stdout: 'pipe', stderr: 'pipe' },
  );
  const reader = child.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  return {
    child,
    release: async () => {
      writeFileSync(release, '');
      await child.exited;
    },
  };
}

function launch(repo: TempRepo, args: string[], env: Record<string, string> = {}, cwd = repo.dir) {
  return Bun.spawn([process.execPath, LAUNCHER, ...args], {
    cwd,
    env: { ...repo.env, TMPDIR: join(repo.home, 'tmp'), SAIL_TEST_LOCK_SECONDS: '2', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function finish(child: ReturnType<typeof launch>) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

const WAIT = (repo: TempRepo) =>
  `scripts/test.ts: waiting up to 2 s for the gate in ${repo.dir}, which holds the machine's test lock\n`;

test("a broad run under RUN_ID waits for a live holder, then stops with exit 2 naming the other run's gate", async () => {
  await withTempRepo(async (repo) => {
    const held = await hold(repo);
    const run = await finish(launch(repo, probes(6), { RUN_ID: 'ADW-1-x' }));
    expect(run.stderr).toStartWith(WAIT(repo));
    expect(run.stderr).toContain("another run's gate holds the machine's test lock");
    expect(run.stderr).toContain('Run the test files you changed by name, 5 or fewer at a time');
    expect(run.code).toBe(2);
    await held.release();
  });
});

test('a broad run takes the lock when the holder exits mid-wait, runs bun test, and frees the lock afterwards', async () => {
  await withTempRepo(async (repo) => {
    const held = await hold(repo);
    const child = launch(repo, probes(6), { RUN_ID: 'ADW-1-x', SAIL_TEST_LOCK_SECONDS: '30' });
    const done = finish(child);
    await Bun.sleep(1500);
    await held.release();
    const run = await done;
    expect(run.stderr).toStartWith(WAIT(repo).replace('2 s', '30 s'));
    expect(run.stderr).not.toContain("another run's gate");
    expect(run.code).not.toBe(2);
    expect(existsSync(lockDir(repo))).toBe(false);
  });
});

test('a run whose SAIL_GATE_LOCK_HOLDER is the live holder prints no wait line', async () => {
  await withTempRepo(async (repo) => {
    const held = await hold(repo);
    const run = await finish(
      launch(repo, probes(6), { RUN_ID: 'ADW-1-x', SAIL_GATE_LOCK_HOLDER: String(held.child.pid) }),
    );
    expect(run.stderr).not.toContain('waiting up to');
    expect(run.code).not.toBe(2);
    await held.release();
  });
});

test('a SAIL_GATE_LOCK_HOLDER naming another pid does not skip the lock', async () => {
  await withTempRepo(async (repo) => {
    const held = await hold(repo);
    const run = await finish(
      launch(repo, probes(6), { RUN_ID: 'ADW-1-x', SAIL_GATE_LOCK_HOLDER: String(process.pid) }),
    );
    expect(run.stderr).toStartWith(WAIT(repo));
    expect(run.code).toBe(2);
    await held.release();
  });
});

test('a run whose holder is its own ancestor prints no wait line', async () => {
  await withTempRepo(async (repo) => {
    lockDir(repo);
    const holder = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { lock } from ${JSON.stringify(MODULE)};
await lock({ label: 'holder', waiting: () => 'x' });
const child = Bun.spawn([process.execPath, ${JSON.stringify(LAUNCHER)}, ...${JSON.stringify(probes(6))}], { stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited === 2 ? 2 : 0);`,
      ],
      {
        cwd: repo.dir,
        env: { ...repo.env, TMPDIR: join(repo.home, 'tmp'), SAIL_TEST_LOCK_SECONDS: '2', RUN_ID: 'ADW-1-x' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const run = await finish(holder);
    expect(run.stderr).not.toContain('waiting up to');
    expect(run.code).toBe(0);
  });
});

test('one named file under RUN_ID, and a broad run without RUN_ID, print no wait line while the lock is held', async () => {
  await withTempRepo(async (repo) => {
    const held = await hold(repo);
    const narrow = await finish(launch(repo, probes(1), { RUN_ID: 'ADW-1-x' }));
    expect(narrow.stderr).not.toContain('waiting up to');
    expect(narrow.code).not.toBe(2);
    const noRun = await finish(launch(repo, probes(6)));
    expect(noRun.stderr).not.toContain('waiting up to');
    expect(noRun.code).not.toBe(2);
    await held.release();
  });
});
