import { expect, test } from 'bun:test';
import { parseCommandArgs } from '../../src/cli/index';

const stage = { options: { bind: { type: 'string', multiple: true } }, positionals: 2 } as const;
const check = { options: { list: { type: 'boolean' } }, positionals: 0 } as const;
const ticket = {
  options: {
    workflow: { type: 'string' },
    until: { type: 'string' },
    force: { type: 'boolean' },
    quiet: { type: 'boolean', short: 'q' },
    verbose: { type: 'boolean', short: 'v', multiple: true },
  },
  positionals: 1,
} as const;

test('positionals and a repeated option are collected in order, keeping = and JSON intact', () => {
  expect(parseCommandArgs(['run', 'x', '--bind', 'a=1', '--bind=b={"k":2}'], stage)).toEqual({
    values: { bind: ['a=1', 'b={"k":2}'] },
    positionals: ['run', 'x'],
  });
});

test('no arguments give no values and no positionals', () => {
  expect(parseCommandArgs([], stage)).toEqual({ values: {}, positionals: [] });
});

test('a boolean option is true, and a single string option takes its last value', () => {
  expect(parseCommandArgs(['--list'], check)).toEqual({ values: { list: true }, positionals: [] });
  const single = { options: { at: { type: 'string' } }, positionals: 0 } as const;
  expect(parseCommandArgs(['--at', 'a', '--at=b'], single)).toEqual({ values: { at: 'b' }, positionals: [] });
});

test('with the ticket spec, each -v counts, -q is a flag, and -x or a value given to --verbose are still refused', () => {
  const given = [['-vv'], ['-v', '-v'], ['--verbose', '-v'], ['-q'], ['-qv']];
  expect(given.map((args) => parseCommandArgs(args, ticket))).toEqual([
    { values: { verbose: 2 }, positionals: [] },
    { values: { verbose: 2 }, positionals: [] },
    { values: { verbose: 2 }, positionals: [] },
    { values: { quiet: true }, positionals: [] },
    { values: { quiet: true, verbose: 1 }, positionals: [] },
  ]);
  expect(parseCommandArgs(['-x'], ticket)).toEqual({ refused: "unknown argument '-x'" });
  expect(parseCommandArgs(['--verbose=1'], ticket)).toEqual({ refused: "option '--verbose' takes no value" });
  // The ticket is the one positional, wherever the options around it fall.
  expect(parseCommandArgs(['FAKE-1', '--force', '--until', 'spec', '--workflow=ticket-to-pr'], ticket)).toEqual({
    values: { force: true, until: 'spec', workflow: 'ticket-to-pr' },
    positionals: ['FAKE-1'],
  });
  expect(parseCommandArgs(['FAKE-1', 'FAKE-2'], ticket)).toEqual({ refused: "unknown argument 'FAKE-2'" });
});

test('arguments after -- count as positionals', () => {
  expect(parseCommandArgs(['run', '--', '--bind'], stage)).toEqual({ values: {}, positionals: ['run', '--bind'] });
});

test.each([
  [['--bind'], stage, "option '--bind' needs a value"],
  [['run', 'x', 'y'], stage, "unknown argument 'y'"],
  [['--bogus'], stage, "unknown argument '--bogus'"],
  [['--bogus=1'], stage, "unknown argument '--bogus'"],
  [['-x'], stage, "unknown argument '-x'"],
  [['--list=yes'], check, "option '--list' takes no value"],
  [['extra'], check, "unknown argument 'extra'"],
] as const)('%p is refused', (args, spec, refused) => {
  expect(parseCommandArgs(args, spec)).toEqual({ refused });
});
