// Exclusive slots: one holder per name machine-wide, stale only once the holder's pid is dead.
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSlotsDir,
  readSlot,
  releaseSlot,
  SlotContended,
  SlotError,
  type SlotHolder,
  slotFile,
  takeSlot,
} from '../../src/engine/slots';

const SLOTS = join(import.meta.dir, '..', '..', 'src', 'engine', 'slots.ts');
const NOW = new Date('2026-10-27T09:00:00.000Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-slots-'));
  dirs.push(dir);
  return dir;
}

const holder = (runId: string, pid = process.pid, key = 'verify#1'): SlotHolder => ({
  runId,
  key,
  runDir: `/tmp/${runId}`,
  pid,
});

test('the default slots directory is ~/.sail/slots', () => {
  expect(defaultSlotsDir()).toBe(join(homedir(), '.sail', 'slots'));
});

test('takes a free slot and refuses a second holder while the first is alive', () => {
  const dir = tempDir();
  const first = takeSlot(dir, 'verify', holder('RUN-A'), NOW);
  expect(first).toEqual({
    taken: true,
    slot: { name: 'verify', ...holder('RUN-A'), takenAt: NOW.toISOString() },
  });
  expect(readSlot(dir, 'verify')?.runId).toBe('RUN-A');

  const second = takeSlot(dir, 'verify', holder('RUN-B'), NOW);
  expect(second).toEqual({
    taken: false,
    holder: { name: 'verify', ...holder('RUN-A'), takenAt: NOW.toISOString() },
  });
  expect(readSlot(dir, 'verify')?.runId).toBe('RUN-A');
});

test('another name is another slot', () => {
  const dir = tempDir();
  takeSlot(dir, 'verify', holder('RUN-A'), NOW);
  expect(takeSlot(dir, 'build', holder('RUN-B'), NOW).taken).toBe(true);
});

test('takes over a slot whose holder was killed with SIGKILL', async () => {
  const dir = tempDir();
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { takeSlot } from ${JSON.stringify(SLOTS)};
       takeSlot(${JSON.stringify(dir)}, 'verify', { runId: 'DEAD-1', key: 'verify#1', runDir: '/tmp/dead', pid: process.pid });
       console.log('held'); setInterval(() => {}, 1000);`,
    ],
    { stdout: 'pipe' },
  );
  const reader = child.stdout.getReader();
  await reader.read();
  expect(takeSlot(dir, 'verify', holder('RUN-B'), NOW).taken).toBe(false);

  child.kill('SIGKILL');
  await child.exited;
  const result = takeSlot(dir, 'verify', holder('RUN-B'), NOW);
  expect(result.taken).toBe(true);
  if (result.taken) expect(result.took).toBe('DEAD-1');
  expect(readSlot(dir, 'verify')?.runId).toBe('RUN-B');
});

test('releases only its own slot', () => {
  const dir = tempDir();
  takeSlot(dir, 'verify', holder('RUN-A'), NOW);
  expect(releaseSlot(dir, 'verify', holder('RUN-B'))).toBe(false);
  expect(readSlot(dir, 'verify')?.runId).toBe('RUN-A');
  expect(releaseSlot(dir, 'verify', holder('RUN-A', process.pid, 'other#1'))).toBe(false);
  expect(existsSync(slotFile(dir, 'verify'))).toBe(true);
  expect(releaseSlot(dir, 'verify', holder('RUN-A'))).toBe(true);
  expect(existsSync(slotFile(dir, 'verify'))).toBe(false);
  expect(releaseSlot(dir, 'verify', holder('RUN-A'))).toBe(false);
});

test('one of several takers wins a stale slot', async () => {
  const dir = tempDir();
  const dead = Bun.spawn(['true']);
  await dead.exited;
  takeSlot(dir, 'verify', holder('DEAD-1', dead.pid), NOW);

  const script = `import { takeSlot } from ${JSON.stringify(SLOTS)};
    const id = process.argv[1];
    const r = takeSlot(${JSON.stringify(dir)}, 'verify', { runId: id, key: 'verify#1', runDir: '/tmp/' + id, pid: process.pid });
    console.log(id + ' ' + r.taken);
    await Bun.sleep(1500);`;
  const children = ['T1', 'T2', 'T3', 'T4'].map((id) =>
    Bun.spawn([process.execPath, '-e', script, id], { stdout: 'pipe' }),
  );
  const outputs = await Promise.all(
    children.map(async (child) => {
      const text = await new Response(child.stdout).text();
      await child.exited;
      return text.trim();
    }),
  );
  const winners = outputs.filter((line) => line.endsWith(' true'));
  expect(winners).toHaveLength(1);
  expect(readSlot(dir, 'verify')?.runId).toBe(winners[0]?.split(' ')[0]);
});

test('a slot that kept changing hands throws SlotContended', () => {
  const dir = tempDir();
  const file = slotFile(dir, 'verify');
  const link = fs.linkSync;
  const hook = spyOn(fs, 'linkSync').mockImplementation((src, dst) => {
    if (dst === file) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    return link(src, dst);
  });
  try {
    expect(() => takeSlot(dir, 'verify', holder('B'), NOW)).toThrow(SlotContended);
  } finally {
    hook.mockRestore();
  }
});

test('a release overtaken by a takeover leaves the new holder its slot', () => {
  const dir = tempDir();
  const file = slotFile(dir, 'verify');
  takeSlot(dir, 'verify', holder('A'), NOW);
  const replacement = { name: 'verify', ...holder('B'), takenAt: NOW.toISOString() };
  const read = fs.readFileSync;
  let fired = false;
  const hook = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const text = read(...args);
    if (args[0] === file && !fired) {
      fired = true;
      writeFileSync(file, JSON.stringify(replacement));
    }
    return text;
  }) as typeof fs.readFileSync);
  try {
    expect(releaseSlot(dir, 'verify', holder('A'))).toBe(false);
    expect(readSlot(dir, 'verify')).toEqual(replacement);
    expect(fs.readdirSync(dir)).toEqual(['verify.json']);
  } finally {
    hook.mockRestore();
  }
});

test('a takeover overtaken by another takeover leaves one holder', async () => {
  const dir = tempDir();
  const file = slotFile(dir, 'verify');
  const dead = Bun.spawn(['true']);
  await dead.exited;
  takeSlot(dir, 'verify', holder('dead', dead.pid), NOW);
  const read = fs.readFileSync;
  let fired = false;
  let first: unknown;
  let third: unknown;
  const hook = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const text = read(...args);
    if (args[0] === file && !fired) {
      fired = true;
      first = takeSlot(dir, 'verify', holder('A'), NOW);
      third = takeSlot(dir, 'verify', holder('C'), NOW);
    }
    return text;
  }) as typeof fs.readFileSync);
  const slot = { name: 'verify', ...holder('A'), takenAt: NOW.toISOString() };
  try {
    expect(takeSlot(dir, 'verify', holder('B'), NOW)).toEqual({ taken: false, holder: slot });
    expect(first).toEqual({ taken: true, slot, took: 'dead' });
    expect(third).toEqual({ taken: false, holder: slot });
    expect(readSlot(dir, 'verify')).toEqual(slot);
    expect(fs.readdirSync(dir)).toEqual(['verify.json']);
  } finally {
    hook.mockRestore();
  }
});

test('a live drop token gives SlotContended instead of taking a stale slot', async () => {
  const dir = tempDir();
  const dead = Bun.spawn(['true']);
  await dead.exited;
  takeSlot(dir, 'verify', holder('dead', dead.pid), NOW);
  writeFileSync(`${slotFile(dir, 'verify')}.drop`, JSON.stringify({ pid: process.pid, nonce: 'live' }));
  expect(() => takeSlot(dir, 'verify', holder('A'), NOW)).toThrow(SlotContended);
  expect(readSlot(dir, 'verify')?.runId).toBe('dead');
});

test('an invalid slot file is refused, naming it', () => {
  const dir = tempDir();
  const file = slotFile(dir, 'verify');
  writeFileSync(file, '{"name":"verify"}');
  expect(() => readSlot(dir, 'verify')).toThrow(SlotError);
  expect(() => takeSlot(dir, 'verify', holder('RUN-B'), NOW)).toThrow(file);
  writeFileSync(file, 'not json');
  expect(() => takeSlot(dir, 'verify', holder('RUN-B'), NOW)).toThrow(file);
  expect(readFileSync(file, 'utf8')).toBe('not json');
});
