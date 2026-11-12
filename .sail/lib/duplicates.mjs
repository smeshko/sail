// The duplicate check a filer and groom's duplicates stage run: open tickets, untrusted excerpts, the one same-work
// question, and the ranking of its scores.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_REQUEST_BYTES } from './jev-check.mjs';

/** Confidence at which a filer treats two pieces of work as the same. */
export const SAME_WORK = 0.8;
/** Bound requests by count and serialized UTF-8 bytes, as ADW-387 bounds banned-word questions. */
export const MAX_QUESTIONS = 64;
export { MAX_REQUEST_BYTES };
/** Maximum passage length in the request; full text is retained when filing. */
export const DESCRIPTION_CHARS = 600;
/** An excerpt with a marker when cut. */
export const excerpt = (text) => (text.length > DESCRIPTION_CHARS ? `${text.slice(0, DESCRIPTION_CHARS)}…` : text);

function port(args, input, maxBuffer) {
  const result = spawnSync('sail', ['port', ...args], {
    encoding: 'utf8',
    input: input ?? '',
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
  });
  if (result.status !== 0)
    throw new Error(
      `sail port ${args.join(' ')}: ${(result.stderr || result.error?.message || `exit ${result.status ?? result.signal}`).trim()}`,
    );
  return result.stdout;
}

/** Unstarted and started tickets, or an error when listing fails. */
export function openTickets() {
  const list = (state) => JSON.parse(port(['ticket-source', 'list', '--state', state]).trim().split('\n').at(-1));
  return [...list('unstarted'), ...list('started')];
}

/** Wrap all human-written passages as untrusted input in one call; nothing starts for no passages. */
export const wrapAll = (passages) =>
  passages.length === 0
    ? []
    : JSON.parse(
        port(['render', '--untrusted', '--each'], JSON.stringify(passages), 64 * 1024 * 1024)
          .trim()
          .split('\n')
          .at(-1),
      );

/** The shared same-work question for two state paths. */
export function sameWork(a, b) {
  return {
    type: 'noul',
    instructions: `Do \`${a}\` and \`${b}\` describe the same work?`,
    criteria: {
      true: 'the same change: the same outcome in the same place, worded differently',
      false: 'a different change, even in the same area',
    },
  };
}

/** Asks Jev one request through a body file: the answers by question name; throws the port's error text. */
export function askJev(request) {
  const bodyFile = join(mkdtempSync(join(tmpdir(), 'same-work-')), 'body.json');
  writeFileSync(bodyFile, JSON.stringify(request));
  const result = spawnSync('sail', ['port', 'jev', 'ask', '--body-file', bodyFile], { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error((result.stderr || result.error?.message || `exit ${result.status ?? result.signal}`).trim());
  return JSON.parse(result.stdout.trim().split('\n').at(-1)).answers;
}

/**
 * Groups the pairs' same-work questions into requests bounded by question count and serialized bytes, and returns
 * every answer by pair name. `state` is `{ <collection>: { <id>: entry } }`, a pair `{ name, a, b }` with `a` and `b`
 * as `[collection, id]`; a request carries only the entries its pairs name. Throws when `ask` does, or one pair alone
 * is over the byte limit.
 */
export function askSameWork(state, pairs, ask = askJev) {
  const answers = {};
  const empty = () => ({
    state: Object.fromEntries(Object.keys(state).map((collection) => [collection, {}])),
    questions: {},
  });
  let request = empty();
  const flush = () => {
    if (Object.keys(request.questions).length > 0) Object.assign(answers, ask(request));
  };
  for (const { name, a, b } of pairs) {
    const add = () => {
      const next = {
        state: Object.fromEntries(
          Object.entries(request.state).map(([collection, entries]) => [collection, { ...entries }]),
        ),
        questions: { ...request.questions, [name]: sameWork(`${a[0]}["${a[1]}"]`, `${b[0]}["${b[1]}"]`) },
      };
      next.state[a[0]][a[1]] = state[a[0]][a[1]];
      next.state[b[0]][b[1]] = state[b[0]][b[1]];
      return next;
    };
    let next = add();
    if (
      Object.keys(next.questions).length > MAX_QUESTIONS ||
      Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_REQUEST_BYTES
    ) {
      flush();
      request = empty();
      next = add();
    }
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_REQUEST_BYTES)
      throw new Error('one duplicate-check pair exceeds the Jev request byte limit');
    request = next;
  }
  flush();
  return answers;
}

/** How many tickets groom's check names: the ticket's measurement kept 30 of 32 true pairs at 1.8 candidates a run. */
export const RANK_LIMIT = 3;
/** The lowest score a ticket is named at, from the same measurement. */
export const RANK_FLOOR = 0.05;

/**
 * The closest tickets of `[{ ticketKey, confidence }]`: those at or over the floor, highest first, ties in the order
 * given, cut to the limit, each with why it is named.
 */
export function closest(scores, limit = RANK_LIMIT, floor = RANK_FLOOR) {
  const kept = scores.filter((each) => each.confidence >= floor).sort((a, b) => b.confidence - a.confidence);
  return kept.slice(0, limit).map((each, index) => ({
    ticketKey: each.ticketKey,
    confidence: each.confidence,
    why: `ranked ${index + 1} of ${kept.length} by Jev, score ${each.confidence.toFixed(2)}`,
  }));
}
