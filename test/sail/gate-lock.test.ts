// The machine's gate lock: taking it, waiting for a live holder with and without a cap, taking over a dead holder's.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const MODULE = join(import.meta.dir, '../../.sail/lib/gate-lock.mjs');
const lib = (await import(MODULE)) as {
  HOLDER_ENV: string;
  lockPath(): string;
  heldBy(pid: number): boolean;
};

function tmp(repo: TempRepo): string {
  const dir = join(repo.home, 'tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const script = (body: string) => `import { lock, heldBy, lockPath } from ${JSON.stringify(MODULE)};\n${body}`;

function run(repo: TempRepo, body: string, cwd = repo.dir) {
  return Bun.spawn([process.execPath, '-e', script(body)], {
    cwd,
    env: { ...repo.env, TMPDIR: tmp(repo) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

/** A process that takes the lock and holds it until `release` appears or it is killed. */
async function hold(repo: TempRepo, release = join(repo.home, 'release')) {
  const child = run(
    repo,
    `await lock({ label: 'holder', waiting: () => 'x' });
console.log('held');
while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(50);`,
  );
  const reader = child.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  return { child, release };
}

test('lock takes a free lock, writes the pid and workspace, and frees it when the process exits', async () => {
  await withTempRepo(async (repo) => {
    const child = run(
      repo,
      `console.log(await lock({ label: 'x', waiting: () => 'w' }));
console.log((await Bun.file(lockPath() + '/holder').text()).trim());
console.log(process.pid);`,
    );
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const [taken, holderLine, pid] = out.trim().split('\n');
    expect(taken).toBe('true');
    expect(holderLine).toBe(`${pid} ${repo.dir}`);
    expect(existsSync(join(tmp(repo), 'sail-validate.lock'))).toBe(false);
  });
});

test('lock with a cap prints the waiting line once and resolves false while a live holder stays', async () => {
  await withTempRepo(async (repo) => {
    const held = await hold(repo);
    const waiter = run(
      repo,
      `console.log(await lock({ label: 'probe', waiting: (dir) => 'waiting in ' + dir, seconds: 1 }));`,
      join(repo.home),
    );
    const [out, err] = await Promise.all([
      new Response(waiter.stdout).text(),
      new Response(waiter.stderr).text(),
      waiter.exited,
    ]);
    expect(out.trim()).toBe('false');
    expect(err).toBe(`probe: waiting in ${repo.dir}\n`);
    writeFileSync(held.release, '');
    await held.child.exited;
  });
});

test('lock with a NaN cap pauses between tries rather than spinning', async () => {
  await withTempRepo(async (repo) => {
    const held = await hold(repo);
    const waiter = run(
      repo,
      `const start = process.cpuUsage();
setTimeout(() => { const used = process.cpuUsage(start); console.log(used.user + used.system); process.exit(0); }, 1000);
await lock({ label: 'probe', waiting: () => 'waiting', seconds: Number.NaN });`,
    );
    const [out] = await Promise.all([new Response(waiter.stdout).text(), waiter.exited]);
    expect(Number(out.trim())).toBeLessThan(250_000);
    writeFileSync(held.release, '');
    await held.child.exited;
  });
});

test('lock with a cap takes the lock once the holder exits mid-wait', async () => {
  await withTempRepo(async (repo) => {
    const held = await hold(repo);
    const waiter = run(repo, `console.log(await lock({ label: 'probe', waiting: () => 'waiting', seconds: 20 }));`);
    const err = new Response(waiter.stderr).text();
    await Bun.sleep(1500);
    writeFileSync(held.release, '');
    const out = await new Response(waiter.stdout).text();
    expect(out.trim()).toBe('true');
    expect(await err).toBe('probe: waiting\n');
  });
});

test('a lock whose holder pid is dead is taken over', async () => {
  await withTempRepo(async (repo) => {
    const dead = Bun.spawn([process.execPath, '-e', '']);
    await dead.exited;
    const lockDir = join(tmp(repo), 'sail-validate.lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'holder'), `${dead.pid} /gone\n`);
    const child = run(
      repo,
      `console.log(await lock({ label: 'x', waiting: () => 'w', seconds: 5 }));
console.log((await Bun.file(lockPath() + '/holder').text()).split(' ')[0] === String(process.pid));`,
    );
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(out.trim().split('\n')).toEqual(['true', 'true']);
    expect(err).toBe('');
  });
});

test('heldBy is true for the live holder, false for another pid, and false with no lock', async () => {
  await withTempRepo(async (repo) => {
    const dir = tmp(repo);
    const before = process.env.TMPDIR;
    process.env.TMPDIR = dir;
    try {
      expect(lib.heldBy(process.pid)).toBe(false);
      const held = await hold(repo);
      expect(lib.heldBy(held.child.pid)).toBe(true);
      expect(lib.heldBy(process.pid)).toBe(false);
      expect(lib.heldBy(Number.NaN)).toBe(false);
      expect(readFileSync(join(dir, 'sail-validate.lock/holder'), 'utf8').split(' ')[0]).toBe(String(held.child.pid));
      writeFileSync(held.release, '');
      await held.child.exited;
      expect(lib.heldBy(held.child.pid)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  });
});
