// The screen: plain lines for a pipe, SGR colours in a terminal, text cleaned of escape sequences, and a live line a
// timer redraws, cleared before every printed line.
import { expect, test } from 'bun:test';
import { clean, createScreen, type Every, every, type Line, type Screen } from '../../../src/events/consumers/screen';

const CLEAR = '\r\x1b[2K';

/** A live line as the screen draws it: cleared, then the cyan spinner frame, a space and the dim text. */
const draw = (frame: string, text: string) => `${CLEAR}\x1b[36m${frame}\x1b[0m \x1b[2m${text}\x1b[0m`;

const LINE: Line = [['bold', 'a'], ' b', [['red', 'dim'], 'c']];

/** A fake `every`: records each timer's interval, hands back the last tick, and counts cancels. */
function fakeEvery() {
  const timers = { ms: [] as number[], cancelled: 0, tick: (): void => undefined };
  const fake: Every = (ms, tick) => {
    timers.ms.push(ms);
    timers.tick = tick;
    return () => {
      timers.cancelled++;
    };
  };
  return { every: fake, timers };
}

/** A screen writing into `out`, in a terminal `columns` wide unless `plain`. */
function screen(options: { plain?: boolean; columns?: number } = {}) {
  const { every: fake, timers } = fakeEvery();
  let out = '';
  const created: Screen = createScreen({
    write: (text) => {
      out += text;
    },
    ...(options.plain ? {} : { tty: { columns: () => options.columns ?? 80 } }),
    every: fake,
  });
  return {
    screen: created,
    timers,
    get out() {
      return out;
    },
  };
}

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('plain mode writes each segment unstyled, then a newline', () => {
  const s = screen({ plain: true });
  s.screen.print(LINE);
  expect(s.out).toBe('a bc\n');
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('plain mode never draws a live line and starts no timer', () => {
  const s = screen({ plain: true });
  s.screen.live(() => 'x');
  s.screen.print(['a']);
  s.screen.close();
  expect({ out: s.out, timers: s.timers.ms }).toEqual({ out: 'a\n', timers: [] });
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a terminal wraps each styled segment in its SGR codes, joined by ; for a list', () => {
  const s = screen();
  s.screen.print(LINE);
  expect(s.out).toBe('\x1b[1ma\x1b[0m b\x1b[31;2mc\x1b[0m\n');
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('every segment is cleaned: escape sequences go, and control characters but tab become spaces', () => {
  const raw = '\x1b[31mred\x1b[0m|\x1b[2K|\x1b]0;title\x07|\x1b]8;;fake://x\x1b\\|\x1bc|a\rb\x00c\td\x7fe\nf';
  expect(clean(raw)).toBe('red|||| c|a b c\td e f');

  const plain = screen({ plain: true });
  plain.screen.print([raw]);
  expect(plain.out).toBe('red|||| c|a b c\td e f\n');

  const terminal = screen();
  terminal.screen.print([['bold', 'x\x1b[2Ky']]);
  expect(terminal.out).toBe('\x1b[1mxy\x1b[0m\n');
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a live line starts one 100 ms timer, draws at once, and redraws on each tick with the next frame', () => {
  const s = screen();
  let n = 0;
  s.screen.live(() => `x${n}`);
  expect(s.timers.ms).toEqual([100]);
  expect(s.out).toBe(draw('⠋', 'x0'));

  n = 1;
  s.timers.tick();
  expect(s.out).toBe(draw('⠋', 'x0') + draw('⠙', 'x1'));

  s.screen.live(() => 'y\rz');
  expect(s.timers.ms).toEqual([100]);
  expect(s.out).toEndWith(' \x1b[2my z\x1b[0m');
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a printed line clears the live line first, then redraws it below', () => {
  const s = screen();
  s.screen.live(() => 'x');
  const drawn = s.out;
  s.screen.print(['a']);
  expect(s.out.slice(drawn.length)).toBe(`${CLEAR}a\n${draw('⠋', 'x')}`);
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a live line is cut with … to fit one column short of the width, so it never wraps', () => {
  const s = screen({ columns: 10 });
  s.screen.live(() => 'abcdefghijklmnopqrst');
  const cut = s.out;
  expect(cut).toBe(draw('⠋', 'abcdef…'));
  s.screen.live(() => 'abcdefg');
  expect(s.out.slice(cut.length)).toBe(draw('⠋', 'abcdefg'));
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  .each<[string, (screen: Screen) => void]>([
  ['live(undefined)', (screen) => screen.live(undefined)],
  ['close()', (screen) => screen.close()],
])('%s clears the live line once and stops its timer, and later ticks and closes do nothing', (_, end) => {
  const s = screen();
  s.screen.live(() => 'x');
  const drawn = s.out;
  expect(drawn).toBe(draw('⠋', 'x'));

  end(s.screen);
  expect(s.out.slice(drawn.length)).toBe(CLEAR);
  expect(s.timers.cancelled).toBe(1);

  s.timers.tick();
  s.screen.close();
  expect(s.out.slice(drawn.length)).toBe(CLEAR);
  expect(s.timers.cancelled).toBe(1);
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('the default every runs its tick, and what it returns cancels it', async () => {
  let ticks = 0;
  let cancel = (): void => undefined;
  const ticked = new Promise<string>((resolve) => {
    cancel = every(1, () => {
      ticks++;
      resolve('ticked');
    });
  });
  const first = await Promise.race([ticked, Bun.sleep(1000).then(() => 'no tick within 1 s')]);
  cancel();
  const cancelledAt = ticks;
  await Bun.sleep(30);
  expect({ first, ticksAfterCancel: ticks - cancelledAt }).toEqual({ first: 'ticked', ticksAfterCancel: 0 });
});
