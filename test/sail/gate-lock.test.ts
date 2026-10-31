// The machine's gate lock: taking it, waiting for a live holder with and without a cap, taking over a dead holder's.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const MODULE = join(import.meta.dir, '../../.sail/lib/gate-lock.mjs');
const lib = (await import(MODULE)) as {
  HOLDER_ENV: string;
  lockPath(): string;
  holder(): { pid: number; dir: string } | undefined;
  isAlive(pid: number): boolean;
  heldBy(pid: number): boolean;
  lock(options: { label: string; waiting: (dir: string) => string; seconds?: number }): Promise<boolean>;
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

/** Runs `body` in this process with TMPDIR at the repository's own temp directory, so `lockPath()` is under it. */
async function inProcess(repo: TempRepo, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = tmp(repo);
  const before = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    await body(dir);
  } finally {
    rmSync(join(dir, 'sail-validate.lock'), { recursive: true, force: true });
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
}

/** What `lock` writes to stderr while `body` runs. */
async function stderrOf(body: () => Promise<unknown>): Promise<{ value: unknown; err: string }> {
  const write = process.stderr.write;
  let err = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await body(), err };
  } finally {
    process.stderr.write = write;
  }
}

test('in process, lock takes a free lock, a second lock with a cap waits once, naming the holder, then gives up, and exiting frees it', async () => {
  await withTempRepo(async (repo) => {
    await inProcess(repo, async () => {
      expect(lib.holder()).toBeUndefined();
      const before = new Set(process.listeners('exit'));
      expect(await lib.lock({ label: 'x', waiting: () => 'w' })).toBe(true);
      const onExit = process.listeners('exit').filter((listener) => !before.has(listener));
      expect(onExit).toHaveLength(1);
      expect(lib.holder()).toEqual({ pid: process.pid, dir: process.cwd() });
      expect(lib.heldBy(process.pid)).toBe(true);
      const again = await stderrOf(() =>
        lib.lock({ label: 'probe', waiting: (dir) => `waiting in ${dir}`, seconds: 0.1 }),
      );
      expect(again).toEqual({ value: false, err: `probe: waiting in ${process.cwd()}\n` });
      for (const listener of onExit) {
        process.off('exit', listener);
        listener(0);
      }
      expect(existsSync(lib.lockPath())).toBe(false);
    });
  });
});

test('in process, a lock whose holder pid is dead is taken over', async () => {
  await withTempRepo(async (repo) => {
    await inProcess(repo, async () => {
      const dead = Bun.spawn([process.execPath, '-e', '']);
      await dead.exited;
      mkdirSync(lib.lockPath());
      writeFileSync(join(lib.lockPath(), 'holder'), `${dead.pid} /gone\n`);
      expect(lib.isAlive(dead.pid)).toBe(false);
      const taken = await stderrOf(() => lib.lock({ label: 'x', waiting: () => 'w', seconds: 5 }));
      expect(taken).toEqual({ value: true, err: '' });
      expect(lib.holder()?.pid).toBe(process.pid);
      expect(existsSync(`${lib.lockPath()}.${process.pid}`)).toBe(false);
    });
  });
});

test('in process, a lock with no holder written is waited on while fresh and taken over once 10 s old', async () => {
  await withTempRepo(async (repo) => {
    await inProcess(repo, async () => {
      mkdirSync(lib.lockPath());
      const fresh = await stderrOf(() => lib.lock({ label: 'x', waiting: (dir) => dir, seconds: 0 }));
      expect(fresh).toEqual({ value: false, err: '' });
      const old = (Date.now() - 60_000) / 1000;
      utimesSync(lib.lockPath(), old, old);
      expect(await lib.lock({ label: 'x', waiting: () => 'w', seconds: 5 })).toBe(true);
      expect(lib.holder()?.pid).toBe(process.pid);
    });
  });
});

test('isAlive is true for a process this one may not signal', () => {
  expect(lib.isAlive(1)).toBe(true);
});
