import { expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';

const path = '../.sail/lib/untrusted.mjs';
const { wrapAll } = await import(path);
const result = (stdout: string, status = 0, stderr = '') => ({
  pid: 1,
  output: [null, stdout, stderr],
  stdout,
  stderr,
  status,
  signal: null,
});

test('300 passages use one batch render with a 64 MiB buffer and preserve its output', () => {
  const passages = Array.from({ length: 300 }, (_, i) => ({ text: `Text ${i}`, source: `Source ${i}` }));
  const wrapped = Array.from(
    { length: 300 },
    (_, i) => `<untrusted-input source="Source ${i}">\nText ${i}\n</untrusted-input>`,
  );
  const spawn = spyOn(childProcess, 'spawnSync').mockReturnValue(result(`notice\n${JSON.stringify(wrapped)}\n`));
  try {
    expect(wrapAll(passages)).toEqual(wrapped);
    expect(spawn.mock.calls).toEqual([
      [
        'sail',
        ['port', 'render', '--untrusted', '--batch'],
        {
          encoding: 'utf8',
          input: JSON.stringify(passages),
          maxBuffer: 64 * 1024 * 1024,
        },
      ],
    ]);
  } finally {
    spawn.mockRestore();
  }
});

test('no passages need no render process', () => {
  const spawn = spyOn(childProcess, 'spawnSync');
  try {
    expect(wrapAll([])).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});

test.each([
  [result('', 1, 'renderer unavailable\n'), 'renderer unavailable'],
  [{ ...result(''), status: null, error: new Error('not started') }, 'not started'],
  [{ ...result(''), status: null, signal: 'SIGTERM' as const }, 'exit SIGTERM'],
])('failed render names the command and reason %#', (failed, reason) => {
  const spawn = spyOn(childProcess, 'spawnSync').mockReturnValue(failed);
  try {
    expect(() => wrapAll([{ text: 'text', source: 'source' }])).toThrow(
      `sail port render --untrusted --batch: ${reason}`,
    );
  } finally {
    spawn.mockRestore();
  }
});
