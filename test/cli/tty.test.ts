// detectTty(): the terminal view colours and draws its live line only for an interactive terminal that allows colour.
import { expect, test } from 'bun:test';
import { detectTty } from '../../src/cli/tty';

test('a TTY with NO_COLOR unset or empty and TERM not dumb gets a Tty that reads its width each time, and nothing else does', () => {
  const resized: { isTTY: boolean; columns?: number } = { isTTY: true, columns: 120 };
  const tty = detectTty(resized, {});
  const before = tty?.columns();
  resized.columns = 90;
  const width = (stream: { isTTY?: boolean; columns?: number }, env: Record<string, string | undefined>) =>
    detectTty(stream, env)?.columns() ?? 'plain';
  expect([
    before,
    tty?.columns(),
    width({ isTTY: true }, { TERM: 'xterm-256color' }),
    width({ isTTY: true, columns: 100 }, { NO_COLOR: '' }),
    width({ isTTY: false, columns: 100 }, {}),
    width({ columns: 100 }, {}),
    width({ isTTY: true, columns: 100 }, { NO_COLOR: '1' }),
    width({ isTTY: true, columns: 100 }, { TERM: 'dumb' }),
  ]).toEqual([120, 90, 80, 100, 'plain', 'plain', 'plain', 'plain']);
});
