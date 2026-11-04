// downloadAttachments() and safeFileName(): every hosted file lands as a distinct safe file inside the directory,
// whatever its name, a link is listed and never fetched, a file the source refuses is skipped with its reason, and
// anything but a PortError is a bug that rethrows.
import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createFakeTicketSource } from '../../src/adapters/fake/ticket-source';
import { downloadAttachments, safeFileName } from '../../src/engine/attachments';
import { PortError } from '../../src/ports/errors';
import type { TicketSource } from '../../src/ports/ticket-source';
import type { Attachment } from '../../src/ports/types';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-attachments-'));
  dirs.push(dir);
  return dir;
}

const url = (n: number) => `fake://tickets/FAKE-1/attachments/${n}`;

/** The fake over a ticket FAKE-1 whose attachments are `stored`, and the attachments `get` lists. */
async function ticketWith(stored: object[]): Promise<{ source: TicketSource; attachments: Attachment[] }> {
  const dir = tempDir();
  writeFileSync(
    join(dir, 'tickets.json'),
    JSON.stringify({
      tickets: [
        {
          ticketKey: 'FAKE-1',
          title: 't',
          description: '',
          state: { type: 'unstarted', name: 'Todo' },
          labels: [],
          comments: [],
          links: [],
          attachments: stored,
        },
      ],
    }),
  );
  const source = createFakeTicketSource({ seed: join(dir, 'tickets.json'), state: join(dir, 'state.json') });
  return { source, attachments: (await source.get('FAKE-1')).attachments };
}

test.each([
  ['../../x', 'x'],
  ['.bashrc', 'bashrc'],
  ['a/b.png', 'a_b.png'],
  ['a\\b.png', 'a_b.png'],
  ['..', 'attachment-3'],
  ['', 'attachment-3'],
  ['   ', 'attachment-3'],
  ['shot: 1?.png', 'shot_ 1_.png'],
  ['tab\tname.txt', 'tab_name.txt'],
  ['/etc/passwd', 'etc_passwd'],
])('safeFileName turns %j into %j', (name, expected) => {
  expect(safeFileName(name, new Set(), 3)).toBe(expected);
});

test('safeFileName numbers a repeated name, whatever its case, before its extension, and counts the names taken', () => {
  const taken = new Set<string>();
  const names = ['dup.txt', 'dup.txt', 'DUP.txt', 'dup.txt', 'Makefile', 'makefile'].map((name) =>
    safeFileName(name, taken, 1),
  );
  expect(names).toEqual(['dup.txt', 'dup-2.txt', 'DUP-3.txt', 'dup-4.txt', 'Makefile', 'makefile-2']);
});

test('safeFileName caps a long name at 100 characters, keeping its extension', () => {
  const name = safeFileName(`${'a'.repeat(300)}.png`, new Set(), 1);
  expect([name.length, name.endsWith('.png'), name.startsWith('aaa')]).toEqual([100, true, true]);
});

test('every hostile and repeated name lands as a distinct file inside the directory, with its own bytes', async () => {
  const names = ['../../x', '.bashrc', 'a/b.png', '', 'dup.txt', 'dup.txt'];
  const { source, attachments } = await ticketWith(
    names.map((name, i) => ({ name, url: url(i + 1), content: `body-${i + 1}` })),
  );
  const parent = tempDir();
  const dir = join(parent, 'attachments');
  const outcomes = await downloadAttachments(source, 'FAKE-1', attachments, dir);
  expect(outcomes.map((outcome) => outcome.file)).toEqual([
    'x',
    'bashrc',
    'a_b.png',
    'attachment-4',
    'dup.txt',
    'dup-2.txt',
  ]);
  expect(readdirSync(dir).sort()).toEqual(['a_b.png', 'attachment-4', 'bashrc', 'dup-2.txt', 'dup.txt', 'x']);
  expect(readdirSync(parent)).toEqual(['attachments']);
  for (const [i, outcome] of outcomes.entries()) {
    const path = realpathSync(join(dir, outcome.file ?? ''));
    expect(path.startsWith(`${realpathSync(dir)}${sep}`)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(`body-${i + 1}`);
  }
});

test('a link is listed with link set, never handed to download, and a ticket with only links makes no directory', async () => {
  const { source, attachments } = await ticketWith([{ name: 'Figma', url: 'https://www.figma.com/file/abc' }]);
  const calls: string[] = [];
  const spy: TicketSource = {
    ...source,
    download: async (...args) => {
      calls.push(args[1]);
      return source.download(...args);
    },
  };
  const dir = join(tempDir(), 'attachments');
  expect(await downloadAttachments(spy, 'FAKE-1', attachments, dir)).toEqual([
    { name: 'Figma', url: 'https://www.figma.com/file/abc', link: true },
  ]);
  expect(calls).toEqual([]);
  expect(existsSync(dir)).toBe(false);
});

test('a file the source refuses is skipped with the reason, an oversized one says so, and the others are still saved', async () => {
  const { source, attachments } = await ticketWith([
    { name: 'video.mov', url: url(1), size: 89128960 },
    { name: 'gone.png', url: url(2), answer: 'unavailable', content: 'x' },
    { name: 'ok.txt', url: url(3), content: 'fine' },
  ]);
  const dir = join(tempDir(), 'attachments');
  const outcomes = await downloadAttachments(source, 'FAKE-1', attachments, dir);
  expect(outcomes).toEqual([
    { name: 'video.mov', url: url(1), skipped: 'video.mov: 85 MiB, over the 20 MiB cap, not downloaded' },
    { name: 'gone.png', url: url(2), skipped: 'gone.png: not downloaded: fake: download refused (scripted)' },
    { name: 'ok.txt', url: url(3), file: 'ok.txt' },
  ]);
  expect(readdirSync(dir)).toEqual(['ok.txt']);
});

test('a mime type of the ticket is kept on the outcome', async () => {
  const { source, attachments } = await ticketWith([
    { name: 'a.txt', url: url(1), mimeType: 'text/plain', content: 'a' },
  ]);
  const [outcome] = await downloadAttachments(source, 'FAKE-1', attachments, join(tempDir(), 'a'));
  expect(outcome).toEqual({ name: 'a.txt', url: url(1), mimeType: 'text/plain', file: 'a.txt' });
});

test('a name already in the directory is never overwritten: the new file takes the next free name', async () => {
  const { source, attachments } = await ticketWith([{ name: 'a.txt', url: url(1), content: 'new' }]);
  const dir = tempDir();
  writeFileSync(join(dir, 'a.txt'), 'old');
  const [outcome] = await downloadAttachments(source, 'FAKE-1', attachments, dir);
  expect([outcome?.file, readFileSync(join(dir, 'a.txt'), 'utf8'), readFileSync(join(dir, 'a-2.txt'), 'utf8')]).toEqual(
    ['a-2.txt', 'old', 'new'],
  );
});

test('a name that is a symlink in the directory is not followed', async () => {
  const { source, attachments } = await ticketWith([{ name: 'a.txt', url: url(1), content: 'new' }]);
  const dir = tempDir();
  const target = join(tempDir(), 'target');
  writeFileSync(target, 'untouched');
  symlinkSync(target, join(dir, 'a.txt'));
  const [outcome] = await downloadAttachments(source, 'FAKE-1', attachments, dir);
  expect([outcome?.file, readFileSync(target, 'utf8')]).toEqual(['a-2.txt', 'untouched']);
});

test('an error that is no PortError is a bug and rethrows, and so does an abort of the run', async () => {
  const { source, attachments } = await ticketWith([{ name: 'a.txt', url: url(1), content: 'a' }]);
  const broken: TicketSource = {
    ...source,
    download: async () => {
      throw new TypeError('bug');
    },
  };
  await expect(downloadAttachments(broken, 'FAKE-1', attachments, tempDir())).rejects.toThrow('bug');
  const controller = new AbortController();
  const aborting: TicketSource = {
    ...source,
    download: async () => {
      controller.abort();
      throw new PortError('ticketSource', 'download', 'unavailable', 'interrupted');
    },
  };
  await expect(downloadAttachments(aborting, 'FAKE-1', attachments, tempDir(), controller.signal)).rejects.toThrow(
    'interrupted',
  );
});
