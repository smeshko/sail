// A pi provider's limit wording: Codex's, pi-ai's quota and subscription limits, a rate limit pi's retry gave up on,
// and the reset time each text gives, as Claude's "resets 3pm (zone)" or pi-ai's "try again in ~N min".
import { expect, test } from 'bun:test';
import { limitText, resetsFromText } from '../../../src/adapters/pi/usage-limit';

const NOW = new Date('2026-10-30T01:00:00.000Z');

test("Codex's, OpenAI's, OpenCode's and a gateway's limit texts are limits", () => {
  const texts = [
    'Codex error: The usage limit has been reached',
    'You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.',
    'Codex error: usage_limit_reached',
    'subscription_sharing_usage_limit_exceeded',
    'You exceeded your current quota, please check your plan and billing details. insufficient_quota',
    'GoUsageLimitError: Monthly usage limit reached',
    'Quota exceeded for this project',
    '429 Too Many Requests',
    'Rate limit reached for gpt-6 on tokens per min',
    "You've hit your session limit · resets 4:20pm (Europe/Sofia)",
  ];
  expect(texts.filter((text) => !limitText(text))).toEqual([]);
});

test('a key, a network or a status that is not 429 is not a limit, and nor is 429 inside a longer number', () => {
  const texts = ['401 invalid api key', 'connect ECONNREFUSED', '500 internal error', 'request id 14290 failed'];
  expect(texts.filter(limitText)).toEqual([]);
});

test("pi-ai's try-again time is read in minutes, seconds or hours against now", () => {
  expect([
    resetsFromText('You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.', NOW),
    resetsFromText('Hugging Face rate limit reached; retry in 30s', NOW),
    resetsFromText('limit reached, try again in 2 hours', NOW),
  ]).toEqual(['2026-10-30T01:42:00.000Z', '2026-10-30T01:00:30.000Z', '2026-10-30T03:00:00.000Z']);
});

test("Claude's resets wording keeps its reset, and a text with no time gives none", () => {
  expect(resetsFromText("You've hit your limit · resets 3am (UTC)", NOW)).toBe('2026-10-30T03:00:00.000Z');
  expect(resetsFromText('Codex error: The usage limit has been reached', NOW)).toBeUndefined();
});
