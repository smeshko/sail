// The duplicate check a filer runs: open tickets, untrusted excerpts, and the one same-work question.
import { spawnSync } from 'node:child_process';

/** Confidence at which a filer treats two pieces of work as the same. */
export const SAME_WORK = 0.8;
/** Keep each request within what TypeSafe accepts, as ADW-387 bounds banned-word questions. */
export const MAX_QUESTIONS = 64;
/** Maximum description length in the request. */
export const DESCRIPTION_CHARS = 600;
/** An excerpt with a marker when cut. */
export const excerpt = (text) => (text.length > DESCRIPTION_CHARS ? `${text.slice(0, DESCRIPTION_CHARS)}…` : text);

function port(args, input) {
  const result = spawnSync('sail', ['port', ...args], { encoding: 'utf8', input: input ?? '' });
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
