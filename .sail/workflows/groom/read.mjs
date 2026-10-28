// Reads the ticket in $INPUT_SOURCE through `sail port ticket-source get`, and the team's unstarted and started tickets
// through `list`. Writes ticket.json, brief.md (the ticket, with every passage a person wrote wrapped as untrusted
// input) and others.md (the other open tickets, their states and titles wrapped the same way). Makes no claim. Prints the GroomInput,
// with the other open tickets' keys.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { ticketKey } = JSON.parse(readFileSync(process.env.INPUT_SOURCE, 'utf8'));
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

const ticket = json(['ticket-source', 'get', ticketKey]);
writeFileSync(join(out, 'ticket.json'), `${JSON.stringify(ticket, null, 2)}\n`);

const brief = [
  `# ${ticket.ticketKey}`,
  '',
  `State (${ticket.state.type}):`,
  '',
  wrap(ticket.state.name, `ticket ${ticketKey}, state`),
  '',
  'Labels:',
  '',
  ...(ticket.labels.length === 0
    ? ['None.']
    : ticket.labels.flatMap((label, index) => [wrap(label, `ticket ${ticketKey}, label ${index + 1}`), ''])),
  '',
  '## Title',
  '',
  wrap(ticket.title, `ticket ${ticketKey}, title`),
  '',
  '## Description',
  '',
  wrap(ticket.description || '(none)', `ticket ${ticketKey}, description`),
  '',
  '## Comments',
  '',
  ...(ticket.comments.length === 0
    ? ['None.']
    : ticket.comments.flatMap((comment, index) => [
        wrap(comment.body, `ticket ${ticketKey}, comment ${index + 1} by ${comment.author}`),
        '',
      ])),
  '',
];
writeFileSync(join(out, 'brief.md'), brief.join('\n'));

const open = [
  ...json(['ticket-source', 'list', '--state', 'unstarted']),
  ...json(['ticket-source', 'list', '--state', 'started']),
].filter((other) => other.ticketKey !== ticketKey);
const others = open.map(
  (other) =>
    `- ${other.ticketKey}: ${wrap(other.state.name, `ticket ${other.ticketKey}, state`)} ${wrap(other.title, `ticket ${other.ticketKey}, title`)}`,
);
writeFileSync(
  join(out, 'others.md'),
  ['# Other open tickets', '', ...(others.length === 0 ? ['None.'] : others), ''].join('\n'),
);

console.log(
  JSON.stringify({
    ticketKey: ticket.ticketKey,
    title: ticket.title,
    state: ticket.state,
    others: open.map((other) => other.ticketKey),
  }),
);
