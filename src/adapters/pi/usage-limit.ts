// Recognising a pi provider's usage limit from its text alone (ADW-381). pi-ai words the limits that outlast a retry
// (quota, billing, a subscription's usage limit) and Codex's own ("The usage limit has been reached", "You have hit
// your ChatGPT usage limit"); a rate limit or a 429 reaches the session only once pi's auto-retry gave up on it, so it
// counts too. The reset time is Claude's "resets 3pm (zone)" or pi-ai's "try again in ~N min"; a provider that rewords
// its error ends the step as `harness` until its wording is added here.
import { resetsFromText as resetsFromClaudeText } from '../claude-code/usage-limit';

const LIMIT = new RegExp(
  [
    'hit your [^·]*limit',
    'usage.?limit',
    'usage_not_included',
    'insufficient_quota',
    'quota.?exceeded',
    'out of budget',
    'available balance',
    'billing',
    'rate.?limit',
    'too many requests',
    'resource.?exhausted',
    '(?<![a-z0-9])429(?![a-z0-9])',
  ].join('|'),
  'i',
);

/** Whether `text` says the provider refused for a usage, quota or rate limit. */
export function limitText(text: string): boolean {
  return LIMIT.test(text);
}

const TRY_AGAIN = /(?:try again|retry) in ~?(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|mins?|minutes?|h|hours?)\b/i;

const UNIT_MS: Readonly<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000 };

/** The reset time `text` gives, read against `now`, or undefined when it gives none. */
export function resetsFromText(text: string, now: Date): string | undefined {
  const claude = resetsFromClaudeText(text, now);
  if (claude !== undefined) return claude;
  const found = TRY_AGAIN.exec(text);
  if (found === null) return undefined;
  const [, amount, unit] = found as unknown as [string, string, string];
  return new Date(now.getTime() + Number(amount) * (UNIT_MS[unit.charAt(0).toLowerCase()] ?? 0)).toISOString();
}
