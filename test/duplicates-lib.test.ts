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

/** State of `count` tickets and pairs of the one groomed ticket against each. */
const world = (count: number, text = 'x') => {
  const tickets: Record<string, { title: string; description: string }> = {};
  const pairs = [];
  for (let index = 0; index < count; index++) {
    tickets[`T-${index}`] = { title: text, description: text };
    pairs.push({ name: `G:T-${index}`, a: ['ticket', 'G'], b: ['tickets', `T-${index}`] });
  }
  return { state: { ticket: { G: { title: 'g', description: 'g' } }, tickets }, pairs };
};

type Request = {
  state: { ticket: Record<string, unknown>; tickets: Record<string, unknown> };
  questions: Record<string, unknown>;
};
const recorder = () => {
  const requests: Request[] = [];
  const ask = (request: Request) => {
    requests.push(request);
    return Object.fromEntries(Object.keys(request.questions).map((name) => [name, { noul: 0.5 }]));
  };
  return { requests, ask };
};

test('askSameWork splits 65 pairs into requests of 64 and 1 questions and merges their answers', () => {
  const { state, pairs } = world(65);
  const { requests, ask } = recorder();
  const answers = lib.askSameWork(state, pairs, ask);
  expect(requests.map((each) => Object.keys(each.questions).length)).toEqual([64, 1]);
  expect(Object.keys(answers)).toHaveLength(65);
});

test('askSameWork asks nothing for no pairs', () => {
  const { requests, ask } = recorder();
  expect(lib.askSameWork({ ticket: {}, tickets: {} }, [], ask)).toEqual({});
  expect(requests).toHaveLength(0);
});

test('askSameWork splits by serialized bytes so no request passes the limit', () => {
  const { state, pairs } = world(40, 'y'.repeat(900));
  const { requests, ask } = recorder();
  const answers = lib.askSameWork(state, pairs, ask);
  expect(requests.length).toBeGreaterThan(1);
  for (const request of requests)
    expect(Buffer.byteLength(JSON.stringify(request), 'utf8')).toBeLessThanOrEqual(lib.MAX_REQUEST_BYTES);
  expect(Object.keys(answers)).toHaveLength(40);
});

test('askSameWork carries only the entries its questions name, with every collection present', () => {
  const { state, pairs } = world(3);
  const { requests, ask } = recorder();
  lib.askSameWork(state, pairs.slice(0, 2), ask);
  expect(requests).toHaveLength(1);
  expect(Object.keys(requests[0]?.state.tickets ?? {})).toEqual(['T-0', 'T-1']);
  expect(Object.keys(requests[0]?.state.ticket ?? {})).toEqual(['G']);
  expect(requests[0]?.questions['G:T-0']).toEqual(lib.sameWork('ticket["G"]', 'tickets["T-0"]'));
});

test('askSameWork starts the next request with every collection empty of the last one', () => {
  const { state, pairs } = world(65);
  const { requests, ask } = recorder();
  lib.askSameWork(state, pairs, ask);
  expect(Object.keys(requests[1]?.state.tickets ?? {})).toEqual(['T-64']);
});

test('askSameWork throws for one pair over the byte limit', () => {
  const { state, pairs } = world(1, 'z'.repeat(lib.MAX_REQUEST_BYTES));
  expect(() => lib.askSameWork(state, pairs, recorder().ask)).toThrow(
    'one duplicate-check pair exceeds the Jev request byte limit',
  );
});

test('askSameWork throws what its ask throws', () => {
  const { state, pairs } = world(2);
  expect(() =>
    lib.askSameWork(state, pairs, () => {
      throw new Error('jev down');
    }),
  ).toThrow('jev down');
});

test('askJev sends the request in a body file and returns the answers', () => {
  let body = '';
  const spawn = spyOn(childProcess, 'spawnSync').mockImplementation(((_cmd: string, args: string[]) => {
    body = require('node:fs').readFileSync(args[4], 'utf8');
    return result(`${JSON.stringify({ answers: { a: { noul: 1 } } })}\n`);
  }) as never);
  try {
    const request = { state: {}, questions: { a: {} } };
    expect(lib.askJev(request)).toEqual({ a: { noul: 1 } });
    expect((spawn.mock.calls[0]?.[1] ?? []).slice(0, 4)).toEqual(['port', 'jev', 'ask', '--body-file']);
    expect(JSON.parse(body)).toEqual(request);
  } finally {
    spawn.mockRestore();
  }
});

test('askJev throws the port stderr on a non-zero exit', () => {
  const spawn = spyOn(childProcess, 'spawnSync').mockReturnValue(result('', 1, 'jev answered 500'));
  try {
    expect(() => lib.askJev({ state: {}, questions: {} })).toThrow('jev answered 500');
  } finally {
    spawn.mockRestore();
  }
});
