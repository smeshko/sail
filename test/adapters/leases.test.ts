// Branch leases (D9, ADR-0018): one run holds a remote's branch at a time, machine-wide. A second live run is refused
// and told who holds the lease, the same run renews it on a resume, and a stale lease is taken over.
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { defaultLeasesDir, heldLease, readLease, releaseLease, takeLease } from '../../src/adapters/leases';
import { type Status, type StopReason, writeStatus } from '../../src/engine/run-dir';
import { type Lease, type LeaseHolder, LeaseResult, Released } from '../../src/ports/types';
import { caught, messageOf, parseIssues, portFailure } from '../helpers/ports';

const LEASES = join(import.meta.dir, '..', '..', 'src', 'adapters', 'leases.ts');
const REMOTE = 'fake://codehost/fixture';
const BRANCH = 'sail/FAKE-1';
const NOW = new Date('2026-09-29T09:00:00.000Z');
const LATER = new Date('2026-09-29T10:00:00.000Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-leases-'));
  dirs.push(dir);
  return dir;
}

/** Where a lease on `remote` and `branch` lives: the first 16 hex of sha256(`<remote>\n<branch>`), plus `.json`. */
function leaseFile(dir: string, remote: string, branch: string): string {
  const hex = new Bun.CryptoHasher('sha256').update(`${remote}\n${branch}`).digest('hex');
  return join(dir, `${hex.slice(0, 16)}.json`);
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true']);
  await child.exited;
  return child.pid;
}

/** A holder for run `runId`, whose run directory holds `status` (none when left out), with `pid`. */
function run(runId: string, pid: number, status?: Status, stopReason?: StopReason): LeaseHolder {
  const runDir = join(tempDir(), runId);
  mkdirSync(runDir);
  if (status !== undefined) writeStatus(runDir, status, stopReason);
  return { runId, runDir, pid };
}

const leaseOf = (holder: LeaseHolder, takenAt: Date, branch = BRANCH): Lease => ({
  remote: REMOTE,
  branch,
  ...holder,
  takenAt: takenAt.toISOString(),
});

/** A result without its raw. */
function bare(result: { raw: unknown }): Record<string, unknown> {
  const { raw: _raw, ...rest } = result;
  return rest;
}

test('a first lease creates its file, and readLease gives it back', () => {
  const dir = tempDir();
  const r1 = run('r1', process.pid, 'running');
  expect(readLease(dir, REMOTE, BRANCH)).toBeUndefined();
  const result = takeLease(dir, REMOTE, BRANCH, r1, NOW);
  expect(parseIssues(LeaseResult, result)).toEqual([]);
  expect(bare(result)).toEqual({ leased: true, lease: leaseOf(r1, NOW) });
  expect(existsSync(leaseFile(dir, REMOTE, BRANCH))).toBe(true);
  expect(readLease(dir, REMOTE, BRANCH)).toEqual(leaseOf(r1, NOW));
});

test('a second run is refused while the first is running, and told who holds the lease', () => {
  const dir = tempDir();
  const r1 = run('r1', process.pid, 'running');
  takeLease(dir, REMOTE, BRANCH, r1, NOW);
  const refused = takeLease(dir, REMOTE, BRANCH, run('r2', process.pid, 'running'), LATER);
  expect(parseIssues(LeaseResult, refused)).toEqual([]);
  expect(bare(refused)).toEqual({ leased: false, holder: leaseOf(r1, NOW) });
  expect(readLease(dir, REMOTE, BRANCH)).toEqual(leaseOf(r1, NOW));
});

test('the same run leasing again, once its process is gone, renews its lease with its new pid and time', async () => {
  const dir = tempDir();
  // A suspended run's own process has exited by the time it is resumed.
  const r1 = run('r1', await deadPid(), 'suspended', 'interrupted');
  takeLease(dir, REMOTE, BRANCH, r1, NOW);
  const resumed = { ...r1, pid: process.ppid };
  expect(bare(takeLease(dir, REMOTE, BRANCH, resumed, LATER))).toEqual({
    leased: true,
    lease: leaseOf(resumed, LATER),
  });
  expect(readLease(dir, REMOTE, BRANCH)).toEqual(leaseOf(resumed, LATER));
});

test.each([
  ['completed', 'completed', undefined, 'live'],
  ['failed', 'failed', 'workflow_failed', 'live'],
  ['running with a dead pid', 'running', undefined, 'dead'],
  ['without a STATUS, with a dead pid', undefined, undefined, 'dead'],
] as const)('a lease whose run is %s is stale, and taken over with took', async (_, status, stopReason, pid) => {
  const dir = tempDir();
  takeLease(dir, REMOTE, BRANCH, run('r1', pid === 'live' ? process.pid : await deadPid(), status, stopReason), NOW);
  const r2 = run('r2', process.pid, 'running');
  expect(bare(takeLease(dir, REMOTE, BRANCH, r2, LATER))).toEqual({
    leased: true,
    lease: leaseOf(r2, LATER),
    took: 'r1',
  });
  expect(readLease(dir, REMOTE, BRANCH)).toEqual(leaseOf(r2, LATER));
});

test.each([
  ['suspended, even with a dead pid', 'suspended', 'budget_exceeded', 'dead'],
  ['without a STATUS yet, with a live pid', undefined, undefined, 'live'],
] as const)('a lease whose run is %s is held, and a second run is refused', async (_, status, stopReason, pid) => {
  const dir = tempDir();
  const r1 = run('r1', pid === 'live' ? process.pid : await deadPid(), status, stopReason);
  takeLease(dir, REMOTE, BRANCH, r1, NOW);
  const refused = takeLease(dir, REMOTE, BRANCH, run('r2', process.pid, 'running'), LATER);
  expect(bare(refused)).toEqual({ leased: false, holder: leaseOf(r1, NOW) });
});

test('only the holder releases a lease: another run leaves the file where it is', () => {
  const dir = tempDir();
  takeLease(dir, REMOTE, BRANCH, run('r1', process.pid, 'running'), NOW);
  const byOther = releaseLease(dir, REMOTE, BRANCH, 'r2');
  const keptAfterOther = existsSync(leaseFile(dir, REMOTE, BRANCH));
  const byHolder = releaseLease(dir, REMOTE, BRANCH, 'r1');
  expect([byOther, byHolder].flatMap((result) => parseIssues(Released, result))).toEqual([]);
  expect([bare(byOther), keptAfterOther, bare(byHolder), existsSync(leaseFile(dir, REMOTE, BRANCH))]).toEqual([
    { released: false },
    true,
    { released: true },
    false,
  ]);
});

test('a lease file that is not a lease is invalid, naming the file', () => {
  const dir = tempDir();
  writeFileSync(leaseFile(dir, REMOTE, BRANCH), '{ "runId": 3 }');
  const error = caught(() => readLease(dir, REMOTE, BRANCH));
  expect(portFailure(error)).toEqual({ port: 'workspace', op: 'lease', code: 'invalid' });
  expect(messageOf(error)).toContain(leaseFile(dir, REMOTE, BRANCH));
});

test.each([
  ['a pid of 0', { pid: 0 }, 'holder: pid'],
  ['a negative pid', { pid: -1 }, 'holder: pid'],
  ['no pid', { pid: undefined }, 'holder: pid'],
  ['an empty run id', { runId: '' }, 'holder: runId'],
] as const)('a holder with %s is invalid, and leaves no lease file to block the branch', (_, change, message) => {
  const dir = tempDir();
  const holder = { ...run('r1', process.pid, 'running'), ...change } as LeaseHolder;
  const error = caught(() => takeLease(dir, REMOTE, BRANCH, holder, NOW));
  expect(portFailure(error)).toEqual({ port: 'workspace', op: 'lease', code: 'invalid' });
  expect(messageOf(error)).toContain(message);
  expect(existsSync(leaseFile(dir, REMOTE, BRANCH))).toBe(false);
});

test('a lease file naming pid 0 is invalid: it would read alive forever', () => {
  const dir = tempDir();
  writeFileSync(leaseFile(dir, REMOTE, BRANCH), JSON.stringify(leaseOf(run('r1', 0, 'running'), NOW)));
  expect(portFailure(caught(() => readLease(dir, REMOTE, BRANCH)))).toEqual({
    port: 'workspace',
    op: 'lease',
    code: 'invalid',
  });
});

const unavailable = { port: 'workspace', op: 'lease', code: 'unavailable' };
const asRoot = process.getuid?.() === 0;

test.each([
  ['readLease', (dir: string) => readLease(dir, REMOTE, BRANCH)],
  ['heldLease', (dir: string) => heldLease(dir, REMOTE, BRANCH)],
  ['takeLease', (dir: string) => takeLease(dir, REMOTE, BRANCH, run('r1', process.pid, 'running'), NOW)],
  ['releaseLease', (dir: string) => releaseLease(dir, REMOTE, BRANCH, 'r1')],
] as const)('%s on a lease path that is a directory is unavailable, naming the file and EISDIR', (_, call) => {
  const dir = tempDir();
  mkdirSync(leaseFile(dir, REMOTE, BRANCH));
  const error = caught(() => call(dir));
  expect(portFailure(error)).toEqual(unavailable);
  expect(messageOf(error)).toContain(leaseFile(dir, REMOTE, BRANCH));
  expect(messageOf(error)).toContain('EISDIR');
});

test.skipIf(asRoot)(
  'taking a free branch in a read-only lease directory is unavailable, naming the temp file and EACCES',
  () => {
    const dir = tempDir();
    chmodSync(dir, 0o555);
    try {
      const error = caught(() => takeLease(dir, REMOTE, BRANCH, run('r1', process.pid, 'running'), NOW));
      expect(portFailure(error)).toEqual(unavailable);
      expect(messageOf(error)).toStartWith(
        `workspace.lease: ${leaseFile(dir, REMOTE, BRANCH)}.r1.${process.pid}.tmp: `,
      );
      expect(messageOf(error)).toContain('EACCES');
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(readdirSync(dir)).toEqual([]);
  },
);

test('a lease whose temp-file write fails half way is unavailable, and leaves nothing in the lease directory', () => {
  const dir = tempDir();
  const real = fs.writeFileSync;
  const spy = spyOn(fs, 'writeFileSync').mockImplementation(((path, data, options) => {
    real(path, data, options);
    if (String(path).endsWith('.tmp')) throw new Error('ENOSPC: no space left on device, write');
  }) as typeof fs.writeFileSync);
  try {
    const error = caught(() => takeLease(dir, REMOTE, BRANCH, run('r1', process.pid, 'running'), NOW));
    expect(portFailure(error)).toEqual(unavailable);
    expect(messageOf(error)).toContain(`${leaseFile(dir, REMOTE, BRANCH)}.r1.`);
    expect(messageOf(error)).toContain('.tmp');
    expect(messageOf(error)).toContain('ENOSPC');
  } finally {
    spy.mockRestore();
  }
  expect(readdirSync(dir)).toEqual([]);
  takeLease(dir, REMOTE, BRANCH, run('r1', process.pid, 'running'), NOW);
  expect(readdirSync(dir)).toEqual([basename(leaseFile(dir, REMOTE, BRANCH))]);
});

const errno = (code: string, message: string): Error => Object.assign(new Error(`${code}: ${message}`), { code });

test('taking a free branch whose link fails with an error other than EEXIST is unavailable, naming the lease file, and leaves no temp file', () => {
  const dir = tempDir();
  const file = leaseFile(dir, REMOTE, BRANCH);
  const real = fs.linkSync;
  const link = spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(to) === file) throw errno('EPERM', 'operation not permitted, link');
    return real(from, to);
  });
  try {
    const error = caught(() => takeLease(dir, REMOTE, BRANCH, run('r1', process.pid, 'running'), NOW));
    expect(link).toHaveBeenCalled();
    expect(portFailure(error)).toEqual(unavailable);
    expect(messageOf(error)).toStartWith(`workspace.lease: ${file}: `);
    expect(messageOf(error)).toContain('EPERM');
  } finally {
    link.mockRestore();
  }
  expect(readdirSync(dir)).toEqual([]);
});

test("a release that moves aside another taker's lease and can't link it back is unavailable, naming the lease file", () => {
  const dir = tempDir();
  const file = leaseFile(dir, REMOTE, BRANCH);
  takeLease(dir, REMOTE, BRANCH, run('r1', process.pid, 'running'), NOW);
  const realRename = fs.renameSync;
  const realLink = fs.linkSync;
  const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(from) === file) writeFileSync(file, JSON.stringify(leaseOf(run('r2', process.pid, 'running'), LATER)));
    return realRename(from, to);
  });
  const link = spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(to) === file) throw errno('EIO', 'i/o error, link');
    return realLink(from, to);
  });
  try {
    const error = caught(() => releaseLease(dir, REMOTE, BRANCH, 'r1'));
    expect(rename).toHaveBeenCalled();
    expect(link).toHaveBeenCalled();
    expect(portFailure(error)).toEqual(unavailable);
    expect(messageOf(error)).toStartWith(`workspace.lease: ${file}: `);
    expect(messageOf(error)).toContain('EIO');
  } finally {
    link.mockRestore();
    rename.mockRestore();
  }
});

test.skipIf(asRoot)(
  'releasing a held lease in a read-only lease directory is unavailable, and leaves the lease',
  () => {
    const dir = tempDir();
    takeLease(dir, REMOTE, BRANCH, run('r1', process.pid, 'running'), NOW);
    chmodSync(dir, 0o555);
    try {
      const error = caught(() => releaseLease(dir, REMOTE, BRANCH, 'r1'));
      expect(portFailure(error)).toEqual(unavailable);
      expect(messageOf(error)).toContain(leaseFile(dir, REMOTE, BRANCH));
      expect(messageOf(error)).toContain('EACCES');
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(existsSync(leaseFile(dir, REMOTE, BRANCH))).toBe(true);
  },
);

test('a lease directory that cannot be made is unavailable, naming it', () => {
  const blocker = join(tempDir(), 'file');
  writeFileSync(blocker, '');
  const dir = join(blocker, 'leases');
  const error = caught(() => takeLease(dir, REMOTE, BRANCH, run('r1', process.pid, 'running'), NOW));
  expect(portFailure(error)).toEqual(unavailable);
  expect(messageOf(error)).toContain(dir);
});

test('leases live in ~/.sail/leases unless a caller names a directory', () => {
  expect(defaultLeasesDir()).toBe(join(homedir(), '.sail', 'leases'));
});

test('two runs racing for one stale lease leave exactly one holder, whom the file names', async () => {
  const dir = tempDir();
  takeLease(dir, REMOTE, BRANCH, run('r0', await deadPid(), 'running'), NOW);
  // Both racers wait for the same instant, then take the lease. Each holds it for this live process's pid.
  const at = Date.now() + 500;
  const racer = (runId: string) =>
    Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { takeLease } = await import(${JSON.stringify(LEASES)});
         while (Date.now() < ${at});
         const holder = { runId: '${runId}', runDir: ${JSON.stringify(run(runId, process.pid).runDir)}, pid: ${process.pid} };
         const result = takeLease(${JSON.stringify(dir)}, ${JSON.stringify(REMOTE)}, ${JSON.stringify(BRANCH)}, holder);
         console.log(JSON.stringify({ runId: '${runId}', leased: result.leased }));`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
  const racers = [racer('rA'), racer('rB')];
  const outputs = await Promise.all(
    racers.map(async (child) => ({
      code: await child.exited,
      stdout: (await new Response(child.stdout).text()).trim(),
      stderr: (await new Response(child.stderr).text()).trim(),
    })),
  );
  expect(outputs.map(({ code, stderr }) => ({ code, stderr }))).toEqual([
    { code: 0, stderr: '' },
    { code: 0, stderr: '' },
  ]);
  const winners = outputs
    .map(({ stdout }) => JSON.parse(stdout) as { runId: string; leased: boolean })
    .filter((result) => result.leased)
    .map((result) => result.runId);
  expect(winners).toHaveLength(1);
  expect(readLease(dir, REMOTE, BRANCH)?.runId).toBe(winners[0] as string);
});

const RACE = join(import.meta.dir, '..', 'helpers', 'lease-race.ts');

/** What runs A and B got when B took the lease the moment A had read it, and whom the file names after. */
async function race(mode: 'release' | 'renew'): Promise<unknown> {
  const child = Bun.spawn([process.execPath, RACE, mode, tempDir()], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  return JSON.parse(stdout);
}

test('a release overtaken by a takeover leaves the new holder its lease', async () => {
  expect(await race('release')).toEqual({ a: { released: false }, b: { leased: true, took: 'A' }, file: 'B' });
});

test('a renewal overtaken by a takeover is refused, naming the new holder, and never overwrites its lease', async () => {
  expect(await race('renew')).toEqual({
    a: { leased: false, holder: 'B' },
    b: { leased: true, took: 'A' },
    file: 'B',
  });
});

test('two branches of one remote, and one branch of two remotes, lease apart', () => {
  const dir = tempDir();
  const r1 = run('r1', process.pid, 'running');
  const r2 = run('r2', process.pid, 'running');
  const r3 = run('r3', process.pid, 'running');
  const results = [
    takeLease(dir, REMOTE, 'sail/a', r1, NOW),
    takeLease(dir, REMOTE, 'sail/b', r2, NOW),
    takeLease(dir, 'fake://codehost/other', 'sail/a', r3, NOW),
  ];
  expect(results.map((result) => result.leased)).toEqual([true, true, true]);
  expect([
    readLease(dir, REMOTE, 'sail/a')?.runId,
    readLease(dir, REMOTE, 'sail/b')?.runId,
    readLease(dir, 'fake://codehost/other', 'sail/a')?.runId,
  ]).toEqual(['r1', 'r2', 'r3']);
});

test('a renewal is refused while its run is alive in another process, whatever its STATUS says (a resume or a suspend may be under way), and taken once that process is gone', async () => {
  const dir = tempDir();
  const other = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  try {
    const renewal = (status?: Status, stopReason?: StopReason) => {
      const branch = `sail/${status ?? 'none'}`;
      const held = run('r1', other.pid, status, stopReason);
      takeLease(dir, REMOTE, branch, held, NOW);
      const result = takeLease(dir, REMOTE, branch, { ...held, pid: process.pid }, LATER);
      return result.leased ? `renewed by ${result.lease.pid}` : `refused, held by ${result.holder.pid}`;
    };
    const gone = run('r2', await deadPid(), 'running');
    takeLease(dir, REMOTE, 'sail/gone', gone, NOW);
    const afterDeath = takeLease(dir, REMOTE, 'sail/gone', { ...gone, pid: process.pid }, LATER);
    const left = run('r3', await deadPid(), 'suspended', 'interrupted');
    takeLease(dir, REMOTE, 'sail/left', left, NOW);
    const afterSuspend = takeLease(dir, REMOTE, 'sail/left', { ...left, pid: process.pid }, LATER);
    expect({
      running: renewal('running'),
      starting: renewal(),
      suspended: renewal('suspended', 'interrupted'),
      gone: afterDeath.leased ? `renewed by ${afterDeath.lease.pid}` : 'refused',
      suspendedAndGone: afterSuspend.leased ? `renewed by ${afterSuspend.lease.pid}` : 'refused',
    }).toEqual({
      running: `refused, held by ${other.pid}`,
      starting: `refused, held by ${other.pid}`,
      suspended: `refused, held by ${other.pid}`,
      gone: `renewed by ${process.pid}`,
      suspendedAndGone: `renewed by ${process.pid}`,
    });
  } finally {
    other.kill('SIGKILL');
  }
});

test("heldLease gives a live run's lease, a suspended run's whatever its pid, and nothing for a free branch or a stale lease, which it leaves in place", async () => {
  const dir = tempDir();
  const dead = await deadPid();
  const held = (branch: string, holder: LeaseHolder) => {
    takeLease(dir, REMOTE, branch, holder, NOW);
    return heldLease(dir, REMOTE, branch);
  };
  const live = run('r-live', process.pid);
  const suspended = run('r-suspended', dead, 'suspended', 'interrupted');
  expect({
    free: heldLease(dir, REMOTE, 'sail/FAKE-9'),
    live: held('sail/FAKE-1', live),
    suspended: held('sail/FAKE-2', suspended),
    deadPid: held('sail/FAKE-3', run('r-dead', dead)),
    deadRunning: held('sail/FAKE-4', run('r-running', dead, 'running')),
    completed: held('sail/FAKE-5', run('r-completed', process.pid, 'completed')),
    failed: held('sail/FAKE-6', run('r-failed', process.pid, 'failed', 'stage_error')),
  }).toEqual({
    free: undefined,
    live: leaseOf(live, NOW, 'sail/FAKE-1'),
    suspended: leaseOf(suspended, NOW, 'sail/FAKE-2'),
    deadPid: undefined,
    deadRunning: undefined,
    completed: undefined,
    failed: undefined,
  });
  expect(readLease(dir, REMOTE, 'sail/FAKE-5')?.runId).toBe('r-completed');
});
