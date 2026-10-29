// Comments $INPUT_REASON on the pull request in $INPUT_PR, takes the designation label in $INPUT_LABEL off and puts
// needs-human on. A port call that fails is said on stderr, and the rest still runs: each is worth doing alone.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NEEDS_HUMAN = 'needs-human';
const read = (name) => readFileSync(process.env[name], 'utf8');
const pr = JSON.parse(read('INPUT_PR'));
const label = read('INPUT_LABEL').trim();
const reason = read('INPUT_REASON').trim();

/** Runs `sail port codehost …`: whether it succeeded, saying why on stderr when it didn't. */
function port(args) {
  const result = spawnSync('sail', ['port', 'codehost', ...args], { encoding: 'utf8' });
  if (result.status !== 0) process.stderr.write(`sail port codehost ${args[0]}: ${result.stderr.trim()}\n`);
  return result.status === 0;
}

const body = join(process.env.STAGE_OUT, 'hand-over.md');
writeFileSync(
  body,
  [
    '## sail review',
    '',
    `The review stopped: ${reason}`,
    '',
    `Another run of it would stop the same way, so this pull request needs a human: its \`${label}\` label is off and \`${NEEDS_HUMAN}\` is on. Put \`${label}\` back to review it again.`,
    '',
  ].join('\n'),
);
const commented = port(['comment', String(pr.number), '--body-file', body]);
const unlabelled = port(['remove-label', String(pr.number), label]);
const labelled = port(['add-label', String(pr.number), NEEDS_HUMAN]);
console.log(JSON.stringify({ handedOver: commented && unlabelled && labelled }));
