// Writes $STAGE_OUT/requirements.md: the ticket in $INPUT_TICKETKEY, its title, link and description, which holds its
// acceptance criteria, or a note that the pull request names no ticket. Prints the Requirements.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ticketKey = readFileSync(process.env.INPUT_TICKETKEY, 'utf8').trim();
const out = join(process.env.STAGE_OUT, 'requirements.md');

if (ticketKey === '') {
  writeFileSync(
    out,
    '# No ticket\n\nThis pull request names no ticket. Its requirements are its title and description, in the brief.\n',
  );
  console.log(JSON.stringify({ ticketKey: null }));
  process.exit(0);
}

// A read is safe to repeat: Linear going quiet for a moment (`… (unavailable)`) is retried, after 5 s then 15 s.
const WAITS = [5_000, 15_000];
let result = spawnSync('sail', ['port', 'ticket-source', 'get', ticketKey], { encoding: 'utf8' });
for (const wait of WAITS) {
  if (result.status === 0 || !/\(unavailable\)/.test(result.stderr)) break;
  process.stderr.write(`${result.stderr.trim()}: retrying in ${wait / 1000} s\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  result = spawnSync('sail', ['port', 'ticket-source', 'get', ticketKey], { encoding: 'utf8' });
}
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  throw new Error(`sail port ticket-source get ${ticketKey} exited ${result.status}`);
}
const ticket = JSON.parse(result.stdout.trim().split('\n').at(-1));
const lines = [`# ${ticket.ticketKey}: ${ticket.title}`, '', ticket.url, '', ticket.description.trim(), ''];
for (const comment of ticket.comments ?? [])
  lines.push(`> ${comment.author}: ${comment.body.replace(/\n/g, '\n> ')}`, '');
writeFileSync(out, lines.join('\n'));
console.log(JSON.stringify({ ticketKey: ticket.ticketKey }));
