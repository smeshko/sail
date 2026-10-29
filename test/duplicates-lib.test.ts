import { expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';

const path = '../.sail/lib/duplicates.mjs';
const lib = await import(path);

test('same-work question uses the shared criteria', () => {
  expect(lib.sameWork('ticket', 'other')).toEqual({
    type: 'noul',
    instructions: 'Do `ticket` and `other` describe the same work?',
    criteria: {
      true: 'the same change: the same outcome in the same place, worded differently',
      false: 'a different change, even in the same area',
    },
  });
});

test('excerpt cuts descriptions after 600 characters', () => {
  expect(lib.excerpt(`${'a'.repeat(600)}b`)).toBe(`${'a'.repeat(600)}…`);
  expect(lib.excerpt('short')).toBe('short');
});

/** A completed string-mode port command. */
const result = (stdout: string, status = 0, stderr = '') => ({
  pid: 1,
  output: [null, stdout, stderr],
  stdout,
  stderr,
  status,
  signal: null,
});

test('open tickets combines the last JSON line of both open states', () => {
  const spawn = spyOn(childProcess, 'spawnSync');
  spawn.mockReturnValueOnce(result('notice\n[{"key":"ADW-1"}]\n'));
  spawn.mockReturnValueOnce(result('[{"key":"ADW-2"}]\n'));
  try {
    expect(lib.openTickets()).toEqual([{ key: 'ADW-1' }, { key: 'ADW-2' }]);
    for (const [index, state] of ['unstarted', 'started'].entries()) {
      expect(spawn.mock.calls[index]).toEqual([
        'sail',
        ['port', 'ticket-source', 'list', '--state', state],
        { encoding: 'utf8', input: '' },
      ]);
    }
  } finally {
    spawn.mockRestore();
  }
});

test('wrapAll sends every passage to one renderer and parses its last JSON line', () => {
  const passages = [
    { text: 'first', source: 'follow-up' },
    { text: 'second', source: 'ticket' },
  ];
  const wrapped = ['<untrusted-input>first</untrusted-input>', '<untrusted-input>second</untrusted-input>'];
  const spawn = spyOn(childProcess, 'spawnSync').mockReturnValue(result(`notice\n${JSON.stringify(wrapped)}\n`));
  try {
    expect(lib.wrapAll(passages)).toEqual(wrapped);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('sail', ['port', 'render', '--untrusted', '--each'], {
      encoding: 'utf8',
      input: JSON.stringify(passages),
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    spawn.mockRestore();
  }
});

test('wrapAll with no passages returns an empty array without starting sail', () => {
  const spawn = spyOn(childProcess, 'spawnSync');
  try {
    expect(lib.wrapAll([])).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(0);
  } finally {
    spawn.mockRestore();
  }
});

test('a failed listing reports the port command and provider error', () => {
  const spawn = spyOn(childProcess, 'spawnSync').mockReturnValue(result('', 1, 'provider unavailable\n'));
  try {
    expect(() => lib.openTickets()).toThrow('sail port ticket-source list --state unstarted: provider unavailable');
  } finally {
    spawn.mockRestore();
  }
});
