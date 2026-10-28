// Lists the team's unstarted and started tickets through `sail port ticket-source list`, leaves $INPUT_TICKET's own out,
// and asks Jev one `noul` per other ticket in a single `sail port jev ask`, named by the ticket's key. Writes the
// request as request.json. Every title and description in it is wrapped as untrusted input. Prints the Duplicates: the
// tickets Jev answered at 0.5 or more, highest first. With no other open ticket it asks nothing.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ticket = JSON.parse(readFileSync(process.env.INPUT_TICKET, 'utf8'));
const out = process.env.STAGE_OUT;

/** Runs `sail port …` with `input` on stdin: its stdout, or a failed step. */
function port(args, input) {
  const result = spawnSync('sail', ['port', ...args], { encoding: 'utf8', input: input ?? '' });
  if (result.status !== 0)
    throw new Error(
      `sail port ${args.join(' ')}: ${(result.stderr || result.error?.message || `exit ${result.status ?? result.signal}`).trim()}`,
    );
  return result.stdout;
}

const json = (args) => JSON.parse(port(args).trim().split('\n').at(-1));
const wrap = (text, source) => port(['render', '--untrusted', '--source', source], text).trimEnd();

/** The most of each other ticket's description the request carries: enough to judge, not the whole backlog. */
const DESCRIPTION_CHARS = 600;
const excerpt = (text) => (text.length > DESCRIPTION_CHARS ? `${text.slice(0, DESCRIPTION_CHARS)}…` : text);
/** Jev answers at or above this are probably the same work. */
const LIKELY = 0.5;

const open = [
  ...json(['ticket-source', 'list', '--state', 'unstarted']),
  ...json(['ticket-source', 'list', '--state', 'started']),
].filter((other) => other.ticketKey !== ticket.ticketKey);

const state = {
  ticket: {
    ticketKey: ticket.ticketKey,
    title: wrap(ticket.title, `ticket ${ticket.ticketKey}, title`),
    description: wrap(ticket.description || '(none)', `ticket ${ticket.ticketKey}, description`),
  },
  others: Object.fromEntries(
    open.map((other) => [
      other.ticketKey,
      {
        ticketKey: other.ticketKey,
        title: wrap(other.title, `ticket ${other.ticketKey}, title`),
        description: wrap(excerpt(other.description || '(none)'), `ticket ${other.ticketKey}, description`),
      },
    ]),
  ),
};
const questions = Object.fromEntries(
  open.map((other) => [
    other.ticketKey,
    {
      type: 'noul',
      instructions: `Do \`ticket\` and \`others["${other.ticketKey}"]\` describe the same work?`,
      criteria: {
        true: 'the same change: the same outcome in the same place, worded differently',
        false: 'a different change, even in the same area',
      },
    },
  ]),
);
const requestFile = join(out, 'request.json');
writeFileSync(requestFile, `${JSON.stringify({ state, questions }, null, 2)}\n`);

if (open.length === 0) {
  console.log(JSON.stringify({ candidates: [] }));
} else {
  const { answers } = json(['jev', 'ask', '--body-file', requestFile]);
  const candidates = open
    .map((other) => ({ ticketKey: other.ticketKey, confidence: answers[other.ticketKey].noul }))
    .filter((each) => each.confidence >= LIKELY)
    .sort((a, b) => b.confidence - a.confidence)
    .map((each) => ({ ...each, why: `Jev: the same work at ${each.confidence.toFixed(2)}` }));
  console.log(JSON.stringify({ candidates }));
}
