// Ranks the tickets in $INPUT_OTHERS (the intake's list of the other open tickets) against the one in $INPUT_TICKET:
// every title and description is cut and wrapped as untrusted input, one same-work question is asked of Jev for each
// pair in batches (.sail/lib/duplicates.mjs), and the closest tickets over the floor are printed as the Duplicates.
// With no other ticket nothing is asked. When anything from wrapping to the last answer fails, it prints no candidates
// and why in `unchecked`, and exits 0: a Jev that cannot be asked never fails a groom run.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { askSameWork, closest, excerpt, wrapAll } = await import(
  pathToFileURL(join(dirname(process.env.SAIL_CONFIG), 'lib', 'duplicates.mjs')).href
);

const ticket = JSON.parse(readFileSync(process.env.INPUT_TICKET, 'utf8'));
const others = JSON.parse(readFileSync(process.env.INPUT_OTHERS, 'utf8'));

/** The ticket's title and description as the library wraps them. */
const passages = (each) => [
  { text: excerpt(each.title), source: `ticket ${each.ticketKey}, title` },
  { text: excerpt(each.description || '(none)'), source: `ticket ${each.ticketKey}, description` },
];

try {
  if (others.length === 0) {
    console.log(JSON.stringify({ candidates: [] }));
  } else {
    const wrapped = wrapAll([ticket, ...others].flatMap(passages));
    let next = 0;
    const entry = () => ({ title: wrapped[next++], description: wrapped[next++] });
    const state = {
      ticket: { [ticket.ticketKey]: entry() },
      tickets: Object.fromEntries(others.map((other) => [other.ticketKey, entry()])),
    };
    const name = (other) => `${ticket.ticketKey}:${other.ticketKey}`;
    const pairs = others.map((other) => ({
      name: name(other),
      a: ['ticket', ticket.ticketKey],
      b: ['tickets', other.ticketKey],
    }));
    const answers = askSameWork(state, pairs);
    const scores = others.map((other) => ({ ticketKey: other.ticketKey, confidence: answers[name(other)]?.noul ?? 0 }));
    console.log(JSON.stringify({ candidates: closest(scores) }));
  }
} catch (error) {
  const unchecked = String(error?.message ?? error).split('\n')[0];
  process.stderr.write(`duplicates unchecked: ${unchecked}\n`);
  console.log(JSON.stringify({ candidates: [], unchecked }));
}
