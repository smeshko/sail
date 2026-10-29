// Reads the ticket in $INPUT_SOURCE through `sail port ticket-source get`, and the team's unstarted and started tickets
// through `list`. Wraps every human-written passage with one `sail port render` call, then writes ticket.json,
// brief.md and others.md (the other open tickets, their states, labels, titles and description excerpts).
// Makes no claim. Prints the GroomInput, with the other open tickets' keys, the keys groom keeps, and whether a
// review filed the ticket.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { ticketKey } = JSON.parse(readFileSync(process.env.INPUT_SOURCE, 'utf8'));
const out = process.env.STAGE_OUT;

/** Runs `sail port …` with `input` on stdin: its stdout, or a failed step. */
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

const json = (args) => JSON.parse(port(args).trim().split('\n').at(-1));
const wrapAll = (passages) =>
  JSON.parse(
    port(['render', '--untrusted', '--each'], JSON.stringify(passages), 64 * 1024 * 1024)
      .trim()
      .split('\n')
      .at(-1),
  );

const ticket = json(['ticket-source', 'get', ticketKey]);
const open = [
  ...json(['ticket-source', 'list', '--state', 'unstarted']),
  ...json(['ticket-source', 'list', '--state', 'started']),
].filter((other) => other.ticketKey !== ticketKey);
writeFileSync(join(out, 'ticket.json'), `${JSON.stringify(ticket, null, 2)}\n`);

const passages = [];
const passage = (text, source) => passages.push({ text, source }) - 1;
const brief = [
  `# ${ticket.ticketKey}`,
  '',
  `State (${ticket.state.type}):`,
  '',
  passage(ticket.state.name, `ticket ${ticketKey}, state`),
  '',
  'Labels:',
  '',
  ...(ticket.labels.length === 0
    ? ['None.']
    : ticket.labels.flatMap((label, index) => [passage(label, `ticket ${ticketKey}, label ${index + 1}`), ''])),
  '',
  '## Title',
  '',
  passage(ticket.title, `ticket ${ticketKey}, title`),
  '',
  '## Description',
  '',
  passage(ticket.description || '(none)', `ticket ${ticketKey}, description`),
  '',
  '## Comments',
  '',
  ...(ticket.comments.length === 0
    ? ['None.']
    : ticket.comments.flatMap((comment, index) => [
        passage(comment.body, `ticket ${ticketKey}, comment ${index + 1} by ${comment.author}`),
        '',
      ])),
  '',
];

/** The most of each other ticket's description others.md carries: enough to judge a merge, not the whole backlog. */
const DESCRIPTION_CHARS = 600;
const excerpt = (text) => (text.length > DESCRIPTION_CHARS ? `${text.slice(0, DESCRIPTION_CHARS)}…` : text);
const others = open.map((other) => [
  `## ${other.ticketKey}`,
  '',
  passage(other.state.name, `ticket ${other.ticketKey}, state`),
  passage(other.labels.join(', ') || '(no labels)', `ticket ${other.ticketKey}, labels`),
  passage(other.title, `ticket ${other.ticketKey}, title`),
  passage(excerpt(other.description || '(none)'), `ticket ${other.ticketKey}, description`),
  '',
]);
const wrapped = wrapAll(passages);
const lines = (values) => values.map((value) => (typeof value === 'number' ? wrapped[value] : value)).join('\n');
writeFileSync(join(out, 'brief.md'), lines(brief));
/** A started ticket or an epic is someone's work in hand: groom never cancels it or merges it away. */
const kept = [ticket, ...open]
  .filter((each) => each.state.type === 'started' || each.labels.includes('epic'))
  .map((each) => each.ticketKey);
writeFileSync(
  join(out, 'others.md'),
  ['# Other open tickets', '', ...(others.length === 0 ? ['None.'] : others.map(lines)), ''].join('\n'),
);

console.log(
  JSON.stringify({
    ticketKey: ticket.ticketKey,
    title: ticket.title,
    description: ticket.description,
    state: ticket.state,
    others: open.map((other) => other.ticketKey),
    kept,
    fromReview: ticket.labels.includes('code-review'),
  }),
);
