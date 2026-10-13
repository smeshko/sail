// A seeded property test: for random words built from quotes, escapes and plain text, the tokenizer splits the command
// into the same argv that bash does. Bash is the reference, so a split the engine reads differently is a finding.

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { tokenize } from '../../../src/engine/permissions/tokenize';

// Pieces that bash reads the same way with globbing off: no unquoted `$`, backtick, glob or operator characters.
const PIECES = [
  'a',
  'b1',
  '-rf',
  'x/y',
  "'a b'",
  "'a\\b'",
  "''",
  '""',
  '"a b"',
  '"x\\\\y"',
  '"q\\"r"',
  '"s\\$t"',
  '\\a',
  '\\ ',
  '\\\\',
  "\\'",
  '\\"',
];

// A fixed linear congruential generator, so a failing case reproduces exactly.
let seed = 20261013;
function random(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function randomCommand(): string {
  const words: string[] = [];
  const count = 1 + Math.floor(random() * 5);
  for (let w = 0; w < count; w++) {
    const pieces = 1 + Math.floor(random() * 3);
    let word = '';
    for (let p = 0; p < pieces; p++) word += pick(PIECES);
    words.push(word);
  }
  return words.join(' ');
}

/** The argv bash gives a command, with globbing off, read back as NUL-separated words. */
function bashArgv(command: string): string[] {
  const script = `set -f; set -- ${command}; for a in "$@"; do printf '%s\\0' "$a"; done`;
  const run = spawnSync('/bin/bash', ['-c', script]);
  expect(run.status).toBe(0);
  return run.stdout.toString().split('\0').slice(0, -1);
}

test('the words of 300 seeded random commands split as bash splits them', () => {
  for (let i = 0; i < 300; i++) {
    const command = randomCommand();
    const script = tokenize(command);
    const [segment] = script;
    expect({ command, words: segment?.words.map((word) => word.text) }).toEqual({
      command,
      words: bashArgv(command),
    });
  }
});
