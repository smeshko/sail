import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { dropRecord, type PidFileKind, readRecord, takeRecord } from '../../src/engine/pid-file';

import { threeTakers } from '../helpers/three-takers';

const schema = z.object({ runId: z.string(), pid: z.number() });
type Record = z.infer<typeof schema>;
const kind: PidFileKind<Record> = {
  schema,
  error: (code, message) => new Error(`${code}: ${message}`),
  tag: (r) => r.runId,
};
const stale = { runId: 'stale', pid: process.pid };
const a = { runId: 'A', pid: process.pid };
const b = { runId: 'B', pid: process.pid };
const c = { runId: 'C', pid: process.pid };
const blocks = (r: Record) => r.runId !== 'stale';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'sail-pid-file-'));
  dirs.push(dir);
  return { dir, file: join(dir, 'record') };
}
function put(file: string, record: unknown) {
  fs.writeFileSync(file, JSON.stringify(record));
}
const errno = (code: string) => Object.assign(new Error(code), { code });

test('a free file is created whole', () => {
  const { file } = setup();
  expect(takeRecord(file, a, kind, blocks)).toEqual({ taken: true });
  expect(readRecord(file, kind)).toEqual(a);
});
test('a held file is refused naming its holder', () => {
  const { file } = setup();
  put(file, a);
  expect(takeRecord(file, b, kind, blocks)).toEqual({ taken: false, holder: a });
});
test('a stale file is taken with took', () => {
  const { file, dir } = setup();
  put(file, stale);
  expect(takeRecord(file, a, kind, blocks)).toEqual({ taken: true, took: stale });
  expect(readRecord(file, kind)).toEqual(a);
  expect(fs.readdirSync(dir)).toEqual(['record']);
});
test('three contenders leave exactly A with B and C refused naming A', () => {
  const { file, dir } = setup();
  put(file, stale);
  const result = threeTakers(
    file,
    () => takeRecord(file, a, kind, blocks),
    () => takeRecord(file, b, kind, blocks),
    () => takeRecord(file, c, kind, blocks),
  );
  expect(result.b).toEqual({ taken: false, holder: a });
  expect(result.a).toEqual({ taken: true, took: stale });
  expect(result.c).toEqual({ taken: false, holder: a });
  expect(result.protectedRecheck).toBe(true);
  expect(readRecord(file, kind)).toEqual(a);
  expect(fs.readdirSync(dir)).toEqual(['record']);
});
test('a drop whose record was replaced leaves the replacement', () => {
  const { file, dir } = setup();
  put(file, b);
  expect(dropRecord(file, a, kind)).toBe(false);
  expect(readRecord(file, kind)).toEqual(b);
  expect(fs.readdirSync(dir)).toEqual(['record']);
});
test('a take losing both rounds returns contended', () => {
  const { file } = setup();
  const link = fs.linkSync;
  const hook = spyOn(fs, 'linkSync').mockImplementation((src, dst) => {
    if (dst === file) throw errno('EEXIST');
    return link(src, dst);
  });
  try {
    expect(takeRecord(file, a, kind, blocks)).toEqual({ taken: false, contended: true });
  } finally {
    hook.mockRestore();
  }
});
for (const depth of [1, 2]) {
  test(`dead drop tokens at depth ${depth} are broken without leaving tokens`, async () => {
    const { file, dir } = setup();
    put(file, stale);
    const child = Bun.spawn(['true']);
    await child.exited;
    for (let i = 1; i <= depth; i++) put(file + '.drop'.repeat(i), { pid: child.pid, nonce: `dead-${i}` });
    expect(takeRecord(file, a, kind, blocks)).toEqual({ taken: true, took: stale });
    expect(fs.readdirSync(dir)).toEqual(['record']);
  });
}
test('a live drop token past the deadline gives contention', () => {
  const { file } = setup();
  put(file, stale);
  put(`${file}.drop`, { pid: process.pid, nonce: 'live' });
  expect(takeRecord(file, a, kind, blocks, { waitMs: 20 })).toEqual({ taken: false, contended: true });
});
test('an invalid drop token raises invalid naming the token', () => {
  const { file } = setup();
  put(file, stale);
  put(`${file}.drop`, {});
  expect(() => takeRecord(file, a, kind, blocks)).toThrow(`invalid: ${file}.drop:`);
});
test('a half-written temp failure is unavailable and leaves nothing', () => {
  const { file, dir } = setup();
  const write = fs.writeFileSync;
  const hook = spyOn(fs, 'writeFileSync').mockImplementation((path, ...args) => {
    write(path, ...args);
    throw errno('ENOSPC');
  });
  try {
    expect(() => takeRecord(file, a, kind, blocks)).toThrow(`unavailable: ${file}.A.${process.pid}.tmp: ENOSPC`);
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    hook.mockRestore();
  }
});
test('a failed link is unavailable and leaves nothing', () => {
  const { file, dir } = setup();
  const hook = spyOn(fs, 'linkSync').mockImplementation(() => {
    throw errno('EPERM');
  });
  try {
    expect(() => takeRecord(file, a, kind, blocks)).toThrow(`unavailable: ${file}: EPERM`);
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    hook.mockRestore();
  }
});
test('failed temp cleanup never replaces a write error', () => {
  const { file } = setup();
  const write = spyOn(fs, 'writeFileSync').mockImplementation(() => {
    throw errno('ENOSPC');
  });
  const rm = spyOn(fs, 'rmSync').mockImplementation(() => {
    throw errno('EIO');
  });
  try {
    expect(() => takeRecord(file, a, kind, blocks)).toThrow(`unavailable: ${file}.A.${process.pid}.tmp: ENOSPC`);
  } finally {
    write.mockRestore();
    rm.mockRestore();
  }
});
test('failed temp cleanup never fails a successful create', () => {
  const { file } = setup();
  const rm = spyOn(fs, 'rmSync').mockImplementation(() => {
    throw errno('EIO');
  });
  try {
    expect(takeRecord(file, a, kind, blocks)).toEqual({ taken: true });
    expect(readRecord(file, kind)).toEqual(a);
  } finally {
    rm.mockRestore();
  }
});
test('invalid JSON and schema are invalid and filesystem failures unavailable', () => {
  const { file, dir } = setup();
  put(file, {});
  expect(() => readRecord(file, kind)).toThrow(`invalid: ${file}:`);
  fs.writeFileSync(file, 'bad');
  expect(() => readRecord(file, kind)).toThrow(`invalid: ${file}:`);
  expect(() => readRecord(dir, kind)).toThrow(`unavailable: ${dir}:`);
});
test('a matching drop removes the file and a missing drop returns false', () => {
  const { file, dir } = setup();
  put(file, a);
  expect(dropRecord(file, a, kind)).toBe(true);
  expect(dropRecord(file, a, kind)).toBe(false);
  expect(fs.readdirSync(dir)).toEqual([]);
});
