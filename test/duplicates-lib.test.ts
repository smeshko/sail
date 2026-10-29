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

test('wrap sends text and its source to the untrusted renderer', () => {
  const spawn = spyOn(childProcess, 'spawnSync').mockReturnValue(result('<untrusted-input>text</untrusted-input>\n'));
  try {
    expect(lib.wrap('text', 'follow-up')).toBe('<untrusted-input>text</untrusted-input>');
    expect(spawn).toHaveBeenCalledWith('sail', ['port', 'render', '--untrusted', '--source', 'follow-up'], {
      encoding: 'utf8',
      input: 'text',
    });
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
