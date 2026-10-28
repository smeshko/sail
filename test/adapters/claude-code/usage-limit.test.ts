// The provider's usage-limit wording: whether a text says it, and the instant it resets, from the text or an epoch.
import { expect, test } from 'bun:test';
import { limitText, resetsFromEpoch, resetsFromText } from '../../../src/adapters/claude-code/usage-limit';

const MESSAGE = "You've hit your session limit · resets 4:20pm (Europe/Sofia)";

test('a text that says the user hit a limit is recognised, and any other text is not', () => {
  expect([
    limitText(MESSAGE),
    limitText("You've hit your weekly limit · resets Oct 30, 4pm (Europe/Sofia)"),
    limitText('API Error: 500 internal server error'),
    limitText('the session hit its turn limit'),
  ]).toEqual([true, true, false, false]);
});

test('the reset time of the ticket text is the next 4:20pm in Sofia after now, today or tomorrow', () => {
  expect([
    resetsFromText(MESSAGE, new Date('2026-10-28T10:00:00Z')),
    resetsFromText(MESSAGE, new Date('2026-10-28T15:00:00Z')),
  ]).toEqual(['2026-10-28T14:20:00.000Z', '2026-10-29T14:20:00.000Z']);
});

test('a reset time read within a few minutes after it, as in its own minute or on a skewed clock, is that time, not the next day or year', () => {
  expect([
    resetsFromText('resets 4pm (Europe/Sofia)', new Date('2026-10-28T14:00:20Z')),
    resetsFromText('resets Oct 28, 4pm (Europe/Sofia)', new Date('2026-10-28T14:00:20Z')),
    resetsFromText('resets 4pm (Europe/Sofia)', new Date('2026-10-28T14:04:00Z')),
    resetsFromText('resets 4pm (Europe/Sofia)', new Date('2026-10-28T14:06:00Z')),
  ]).toEqual([
    '2026-10-28T14:00:00.000Z',
    '2026-10-28T14:00:00.000Z',
    '2026-10-28T14:00:00.000Z',
    '2026-10-29T14:00:00.000Z',
  ]);
});

test('a reset time without minutes, with a month and day, is that day at that hour in the zone', () => {
  const now = new Date('2026-10-28T10:00:00Z');
  expect([
    resetsFromText('resets Oct 30, 4pm (Europe/Sofia)', now),
    resetsFromText('resets 12am (UTC)', now),
    resetsFromText('resets 12:30pm (America/New_York)', now),
    resetsFromText('resets Jan 5, 9am (UTC)', now),
  ]).toEqual([
    '2026-10-30T14:00:00.000Z',
    '2026-10-29T00:00:00.000Z',
    '2026-10-28T16:30:00.000Z',
    '2027-01-05T09:00:00.000Z',
  ]);
});

test('an unknown zone, a missing zone or an unparseable time gives no reset time', () => {
  const now = new Date('2026-10-28T10:00:00Z');
  expect([
    resetsFromText('resets 4:20pm (Mars/Olympus)', now),
    resetsFromText('resets 4:20pm', now),
    resetsFromText('resets soon (UTC)', now),
    resetsFromText('resets 13pm (UTC)', now),
    resetsFromText('resets Feb 31, 4pm (UTC)', now),
  ]).toEqual([undefined, undefined, undefined, undefined, undefined]);
});

test('an epoch below 1e12 is seconds and one above is milliseconds', () => {
  expect([resetsFromEpoch(1_793_197_200), resetsFromEpoch(1_793_197_200_000)]).toEqual([
    '2026-10-28T14:20:00.000Z',
    '2026-10-28T14:20:00.000Z',
  ]);
});
