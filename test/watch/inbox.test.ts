// The command inbox: a command file is applied once, oldest first, and removed; anything else is rejected and removed.
import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { type Command, commandsDir, type Drained, drainCommands, dropCommand } from '../../src/watch/inbox';
import { openQueue, QUEUE_FILE, queueDir } from '../../src/watch/queue-store';
import { manualClock, ticket } from '../helpers/queue';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-inbox-'));
  dirs.push(dir);
  return dir;
}

/** Drains the inbox into a list. */
async function drain(runs: string): Promise<{ applied: Command[]; drained: Drained }> {
  const applied: Command[] = [];
  const drained = await drainCommands(runs, (command) => applied.push(command));
  return { applied, drained };
}

test('a dropped poll command is applied exactly once, then removed, and a .tmp beside it is left alone', async () => {
  const runs = runsDir();
  const file = dropCommand(runs, { op: 'poll', workflow: 'ticket-to-pr' });
  expect(file.startsWith(`${commandsDir(runs)}/`)).toBe(true);
  expect(basename(file)).toMatch(/^\d{8}T\d{9}-\d+-\d+-[0-9a-f]+\.json$/);
  writeFileSync(join(commandsDir(runs), '.x.tmp'), '{"op":');
  expect(await drain(runs)).toEqual({
    applied: [{ op: 'poll', workflow: 'ticket-to-pr' }],
    drained: { applied: 1, rejected: [] },
  });
  expect(readdirSync(commandsDir(runs))).toEqual(['.x.tmp']);
  expect(await drain(runs)).toEqual({ applied: [], drained: { applied: 0, rejected: [] } });
});

test('commands dropped in order, many within one millisecond, are applied in that order', async () => {
  const runs = runsDir();
  const order = ['c', 'a', 'b', 'q', 'e', 'z', 'm', 'd', 'x', 'f', 'k', 'g', 'w', 'h', 'r', 'i', 'y', 'j', 'n', 'l'];
  for (const workflow of order) dropCommand(runs, { op: 'poll', workflow });
  expect((await drain(runs)).applied.map((command) => command.op === 'poll' && command.workflow)).toEqual(order);
  expect(readdirSync(commandsDir(runs))).toEqual([]);
});

test('a file that is no command, or whose apply throws, is removed and rejected naming the file, and the drain goes on', async () => {
  const runs = runsDir();
  const dir = commandsDir(runs);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '1-broken.json'), '{');
  writeFileSync(join(dir, '2-explode.json'), JSON.stringify({ op: 'explode' }));
  writeFileSync(join(dir, '3-nameless.json'), JSON.stringify({ op: 'poll' }));
  writeFileSync(join(dir, '4-throws.json'), JSON.stringify({ op: 'poll', workflow: 'gone' }));
  writeFileSync(join(dir, '5-fine.json'), JSON.stringify({ op: 'poll', workflow: 'ticket-to-pr' }));
  const applied: string[] = [];
  const drained = await drainCommands(runs, (command) => {
    if (command.op !== 'poll' || command.workflow === 'gone') throw new Error("not polling workflow 'gone'");
    applied.push(command.workflow);
  });
  expect(applied).toEqual(['ticket-to-pr']);
  expect(drained.applied).toBe(1);
  expect(drained.rejected.map((rejected) => basename(rejected.file))).toEqual([
    '1-broken.json',
    '2-explode.json',
    '3-nameless.json',
    '4-throws.json',
  ]);
  const [broken, explode, nameless, throws] = drained.rejected.map((rejected) => rejected.reason);
  expect(broken).toStartWith('1-broken.json is not JSON: ');
  expect(explode).toStartWith('2-explode.json is not a command: op ');
  expect(nameless).toStartWith('3-nameless.json is not a command: workflow ');
  expect(throws).toBe("4-throws.json failed: not polling workflow 'gone'");
  expect(readdirSync(dir)).toEqual([]);
});

test("draining commands leaves a store's queue.json as it was, and only the store names that file, beside the dashboard's reader", async () => {
  const runs = runsDir();
  const store = openQueue({
    runsDir: runs,
    workflow: 'ticket-to-pr',
    label: 'sail',
    now: manualClock('2026-10-14T09:00:00.000Z'),
  });
  if ('refused' in store) throw new Error(store.refused);
  store.add([ticket('FAKE-1')]);
  const path = join(queueDir(runs, 'ticket-to-pr'), 'queue.json');
  expect(existsSync(path)).toBe(true);
  const before = { text: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs };
  dropCommand(runs, { op: 'poll', workflow: 'ticket-to-pr' });
  dropCommand(runs, { op: 'poll', workflow: 'other' });
  expect((await drain(runs)).drained).toEqual({ applied: 2, rejected: [] });
  expect({ text: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs }).toEqual(before);

  expect(QUEUE_FILE).toBe('queue.json');
  const naming: string[] = [];
  for (const file of new Bun.Glob('**/*.ts').scanSync({ cwd: join(import.meta.dir, '..', '..', 'src') })) {
    const text = await Bun.file(join(import.meta.dir, '..', '..', 'src', file)).text();
    if (text.includes('QUEUE_FILE') || /['"`]queue\.json['"`]/.test(text)) naming.push(file);
  }
  // The dashboard reads queue.json, through its contained reader, and never writes it: it imports only fs reads, and no
  // other way to write a file (review R1-7).
  expect(naming.sort()).toEqual(['dashboard/queues.ts', 'watch/queue-store.ts']);
  const reader = await Bun.file(join(import.meta.dir, '..', '..', 'src', 'dashboard', 'queues.ts')).text();
  const fsImports = [...reader.matchAll(/import \{([^}]*)\} from 'node:fs'/g)].flatMap((match) =>
    (match[1] ?? '').split(',').map((name) => name.trim()),
  );
  expect(fsImports.length).toBeGreaterThan(0);
  expect(fsImports.filter((name) => !READS.has(name))).toEqual([]);
  expect(reader.match(/node:fs\/promises|['"]fs['"]|Bun\.write|\.writer\(|node:child_process|Bun\.spawn/g)).toBeNull();
});

/** The fs calls that only read. */
const READS = new Set(['existsSync', 'lstatSync', 'readdirSync', 'readFileSync', 'realpathSync', 'statSync']);

test('a directory, a link or an unreadable file in the inbox is removed and rejected, and the commands around it apply (review #1.5)', async () => {
  const runs = runsDir();
  const dir = commandsDir(runs);
  mkdirSync(join(dir, '1-stray.json', 'inside'), { recursive: true });
  writeFileSync(join(dir, '2-locked.json'), JSON.stringify({ op: 'poll', workflow: 'locked' }));
  chmodSync(join(dir, '2-locked.json'), 0o000);
  const outside = join(runs, 'outside.json');
  writeFileSync(outside, JSON.stringify({ op: 'poll', workflow: 'linked' }));
  symlinkSync(outside, join(dir, '3-link.json'));
  writeFileSync(join(dir, '4-fine.json'), JSON.stringify({ op: 'poll', workflow: 'ticket-to-pr' }));
  const { applied, drained } = await drain(runs);
  expect(applied).toEqual([{ op: 'poll', workflow: 'ticket-to-pr' }]);
  expect(drained.applied).toBe(1);
  expect(drained.rejected.map((rejected) => basename(rejected.file))).toEqual([
    '1-stray.json',
    '2-locked.json',
    '3-link.json',
  ]);
  const [stray, locked, link] = drained.rejected.map((rejected) => rejected.reason);
  expect(stray).toBe('1-stray.json is not a file');
  expect(locked).toStartWith("2-locked.json can't be read: ");
  expect(link).toBe('3-link.json is not a file');
  expect(readdirSync(dir)).toEqual([]);
  expect(existsSync(outside)).toBe(true);
});

test("an entry that can't be removed is reported, and the drain goes on to the commands after it (review #2.5)", async () => {
  const runs = runsDir();
  const dir = commandsDir(runs);
  const locked = join(dir, '1-stray.json', 'locked');
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, 'inside'), '');
  chmodSync(locked, 0o000);
  writeFileSync(join(dir, '2-fine.json'), JSON.stringify({ op: 'poll', workflow: 'ticket-to-pr' }));
  try {
    const { applied, drained } = await drain(runs);
    expect(applied).toEqual([{ op: 'poll', workflow: 'ticket-to-pr' }]);
    expect(drained.applied).toBe(1);
    expect(drained.rejected.map((rejected) => basename(rejected.file))).toEqual(['1-stray.json']);
    expect(drained.rejected[0]?.reason).toStartWith("1-stray.json is not a file, and it can't be removed: ");
    expect(readdirSync(dir)).toEqual(['1-stray.json']);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('a command applied but not removable is applied once, and removed by a later drain that can (review #3.3)', async () => {
  const runs = runsDir();
  const file = dropCommand(runs, { op: 'poll', workflow: 'ticket-to-pr' });
  const dir = commandsDir(runs);
  chmodSync(dir, 0o555);
  try {
    const first = await drain(runs);
    expect(first.applied).toEqual([{ op: 'poll', workflow: 'ticket-to-pr' }]);
    expect(first.drained.applied).toBe(1);
    expect(first.drained.rejected.map((rejected) => rejected.file)).toEqual([file]);
    expect(first.drained.rejected[0]?.reason).toStartWith(`${basename(file)} was applied, and it can't be removed: `);
    const second = await drain(runs);
    expect(second.applied).toEqual([]);
    expect(second.drained.applied).toBe(0);
    expect(second.drained.rejected.map((rejected) => rejected.file)).toEqual([file]);
  } finally {
    chmodSync(dir, 0o755);
  }
  expect(await drain(runs)).toEqual({ applied: [], drained: { applied: 0, rejected: [] } });
  expect(readdirSync(dir)).toEqual([]);
});

test('an apply that returns a promise is awaited before its command file is removed, and watch and unwatch commands drain', async () => {
  const runs = runsDir();
  const file = dropCommand(runs, { op: 'watch', workflows: ['a', 'b'] });
  dropCommand(runs, { op: 'unwatch', workflows: ['a'] });
  const seen: string[] = [];
  const drained = await drainCommands(runs, async (command) => {
    await Bun.sleep(20);
    seen.push(`${command.op} ${existsSync(file)}`);
  });
  expect([seen, drained]).toEqual([['watch true', 'unwatch false'], { applied: 2, rejected: [] }]);
  expect(readdirSync(commandsDir(runs))).toEqual([]);
});
