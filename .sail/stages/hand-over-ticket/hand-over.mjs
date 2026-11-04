// Comments $INPUT_REASON on the ticket in $INPUT_TICKETKEY, takes the designation label in $INPUT_LABEL off, puts
// needs-human on and, when $INPUT_UNSTART is true, moves the ticket to unstarted. A port call that fails is said on
// stderr, and the rest still runs: each is worth doing alone.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NEEDS_HUMAN = 'needs-human';
const read = (name) => readFileSync(process.env[name], 'utf8');
const ticketKey = read('INPUT_TICKETKEY').trim();
const label = read('INPUT_LABEL').trim();
const reason = read('INPUT_REASON').trim();
const workflow = read('INPUT_WORKFLOW').trim();
const unstart = JSON.parse(read('INPUT_UNSTART')) === true;

/** Runs `sail port ticket-source …`: whether it succeeded, saying why on stderr when it didn't. */
function port(args) {
  const result = spawnSync('sail', ['port', 'ticket-source', ...args], { encoding: 'utf8' });
  if (result.status !== 0) process.stderr.write(`sail port ticket-source ${args[0]}: ${result.stderr.trim()}\n`);
  return result.status === 0;
}

const body = join(process.env.STAGE_OUT, 'hand-over.md');
writeFileSync(
  body,
  [
    `## sail ${workflow}`,
    '',
    `The run stopped: ${reason}`,
    '',
    `Another run of it would stop the same way, so this ticket needs a human: its \`${label}\` label is off and \`${NEEDS_HUMAN}\` is on${unstart ? ', and it is back in Todo' : ''}. Clear the cause and put \`${label}\` back to run it again.`,
    '',
    `sail run ${process.env.RUN_ID ?? ''} handed this ticket over.`,
    '',
  ].join('\n'),
);
const taken = [
  port(['comment', ticketKey, '--body-file', body]),
  port(['remove-label', ticketKey, label]),
  port(['add-label', ticketKey, NEEDS_HUMAN]),
];
if (unstart) taken.push(port(['update', ticketKey, '--state', 'unstarted']));
console.log(JSON.stringify({ handedOver: taken.every(Boolean) }));
