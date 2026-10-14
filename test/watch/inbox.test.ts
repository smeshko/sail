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
import { type Command, commandsDir, drainCommands, dropCommand } from '../../src/watch/inbox';
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
function drain(runs: string): { applied: Command[]; drained: ReturnType<typeof drainCommands> } {
  const applied: Command[] = [];
  const drained = drainCommands(runs, (command) => applied.push(command));
  return { applied, drained };
}

test('a dropped poll command is applied exactly once, then removed, and a .tmp beside it is left alone', () => {
  const runs = runsDir();
  const file = dropCommand(runs, { op: 'poll', workflow: 'ticket-to-pr' });
  expect(file.startsWith(`${commandsDir(runs)}/`)).toBe(true);
  expect(basename(file)).toMatch(/^\d{8}T\d{9}-\d+-\d+-[0-9a-f]+\.json$/);
  writeFileSync(join(commandsDir(runs), '.x.tmp'), '{"op":');
  expect(drain(runs)).toEqual({
    applied: [{ op: 'poll', workflow: 'ticket-to-pr' }],
    drained: { applied: 1, rejected: [] },
  });
  expect(readdirSync(commandsDir(runs))).toEqual(['.x.tmp']);
  expect(drain(runs)).toEqual({ applied: [], drained: { applied: 0, rejected: [] } });
});

test('commands dropped in order, many within one millisecond, are applied in that order', () => {
  const runs = runsDir();
  const order = ['c', 'a', 'b', 'q', 'e', 'z', 'm', 'd', 'x', 'f', 'k', 'g', 'w', 'h', 'r', 'i', 'y', 'j', 'n', 'l'];
  for (const workflow of order) dropCommand(runs, { op: 'poll', workflow });
  expect(drain(runs).applied.map((command) => command.op === 'poll' && command.workflow)).toEqual(order);
  expect(readdirSync(commandsDir(runs))).toEqual([]);
});

test('a file that is no command, or whose apply throws, is removed and rejected naming the file, and the drain goes on', () => {
  const runs = runsDir();
  const dir = commandsDir(runs);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '1-broken.json'), '{');
  writeFileSync(join(dir, '2-explode.json'), JSON.stringify({ op: 'explode' }));
  writeFileSync(join(dir, '3-nameless.json'), JSON.stringify({ op: 'poll' }));
  writeFileSync(join(dir, '4-throws.json'), JSON.stringify({ op: 'poll', workflow: 'gone' }));
  writeFileSync(join(dir, '5-fine.json'), JSON.stringify({ op: 'poll', workflow: 'ticket-to-pr' }));
  const applied: string[] = [];
  const drained = drainCommands(runs, (command) => {
    if (command.workflow === 'gone') throw new Error("not polling workflow 'gone'");
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

test("draining commands leaves a store's queue.json as it was, and only the store names that file", async () => {
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
  expect(drain(runs).drained).toEqual({ applied: 2, rejected: [] });
  expect({ text: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs }).toEqual(before);

  expect(QUEUE_FILE).toBe('queue.json');
  const naming: string[] = [];
  for (const file of new Bun.Glob('**/*.ts').scanSync({ cwd: join(import.meta.dir, '..', '..', 'src') })) {
    const text = await Bun.file(join(import.meta.dir, '..', '..', 'src', file)).text();
    if (text.includes('QUEUE_FILE') || /['"`]queue\.json['"`]/.test(text)) naming.push(file);
  }
  expect(naming).toEqual(['watch/queue-store.ts']);
});

test('a directory, a link or an unreadable file in the inbox is removed and rejected, and the commands around it apply (review #1.5)', () => {
  const runs = runsDir();
  const dir = commandsDir(runs);
  mkdirSync(join(dir, '1-stray.json', 'inside'), { recursive: true });
  writeFileSync(join(dir, '2-locked.json'), JSON.stringify({ op: 'poll', workflow: 'locked' }));
  chmodSync(join(dir, '2-locked.json'), 0o000);
  const outside = join(runs, 'outside.json');
  writeFileSync(outside, JSON.stringify({ op: 'poll', workflow: 'linked' }));
  symlinkSync(outside, join(dir, '3-link.json'));
  writeFileSync(join(dir, '4-fine.json'), JSON.stringify({ op: 'poll', workflow: 'ticket-to-pr' }));
  const { applied, drained } = drain(runs);
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

test("an entry that can't be removed is reported, and the drain goes on to the commands after it (review #2.5)", () => {
  const runs = runsDir();
  const dir = commandsDir(runs);
  const locked = join(dir, '1-stray.json', 'locked');
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, 'inside'), '');
  chmodSync(locked, 0o000);
  writeFileSync(join(dir, '2-fine.json'), JSON.stringify({ op: 'poll', workflow: 'ticket-to-pr' }));
  try {
    const { applied, drained } = drain(runs);
    expect(applied).toEqual([{ op: 'poll', workflow: 'ticket-to-pr' }]);
    expect(drained.applied).toBe(1);
    expect(drained.rejected.map((rejected) => basename(rejected.file))).toEqual(['1-stray.json']);
    expect(drained.rejected[0]?.reason).toStartWith("1-stray.json is not a file, and it can't be removed: ");
    expect(readdirSync(dir)).toEqual(['1-stray.json']);
  } finally {
    chmodSync(locked, 0o755);
  }
});
