// Names the ticket the one in $INPUT_TICKETKEY must wait on, given its new plan in $INPUT_PLAN: the open ticket labelled
// `planned` whose plan, the one attached last by its trailer's `attachedAt`, names a path the new plan names too
// (.sail/lib/overlap.mjs). Among several it takes the one whose plan was attached last. A candidate that already waits
// on this ticket, directly or through its open prerequisites, is passed over for the next, since blocking each by the
// other would hold both for good. Each candidate's files are downloaded into $TMPDIR/<ticket key>/. Prints the Overlap;
// a `sail port` call that fails fails the step.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const library = (name) => import(pathToFileURL(join(dirname(process.env.SAIL_CONFIG), 'lib', name)).href);
const lib = await library('overlap.mjs');
const { parseTasks } = await library('jev-check.mjs');

const ticketKey = readFileSync(process.env.INPUT_TICKETKEY, 'utf8').trim();
const mine = lib.planPaths(readFileSync(process.env.INPUT_PLAN, 'utf8'), parseTasks);

/** The most tickets read while following one candidate's prerequisites. */
const MAX_WALK = 50;

/** Runs `sail port ticket-source …`, failing the step when it fails: its one line of JSON. */
function port(args) {
  const result = spawnSync('sail', ['port', 'ticket-source', ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`sail port ticket-source ${args.join(' ')}: ${(result.stderr ?? '').trim()}`);
  }
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

/** Whether the prerequisite still holds its ticket: its state is unread, or neither completed nor canceled. */
const open = (each) => each.state === undefined || (each.state.type !== 'completed' && each.state.type !== 'canceled');

/**
 * Whether `from` waits on the ticket: 'waits' when the ticket is among the open prerequisites reached from it, 'past'
 * when the walk read MAX_WALK tickets without an end, and 'free' otherwise. Breadth first, each ticket read once; a
 * prerequisite with no state is not followed.
 */
function waitsOn(from) {
  const seen = new Set([from]);
  const queue = [from];
  let read = 0;
  while (queue.length > 0) {
    if (read === MAX_WALK) return 'past';
    const prerequisites = (port(['get', queue.shift()]).prerequisites ?? []).filter(open);
    read++;
    if (prerequisites.some((each) => each.ticketKey === ticketKey)) return 'waits';
    for (const each of prerequisites) {
      if (each.state === undefined || seen.has(each.ticketKey)) continue;
      seen.add(each.ticketKey);
      queue.push(each.ticketKey);
    }
  }
  return 'free';
}

const answer = { blockedBy: null, why: null, shared: [], compared: [], notes: [] };

if (mine.length === 0) {
  answer.notes.push('the plan names no path');
} else {
  const scratch = process.env.TMPDIR || mkdtempSync(join(tmpdir(), 'overlap-'));
  const keys = [];
  for (const state of ['unstarted', 'started']) {
    for (const listed of port(['list', '--state', state, '--label', 'planned'])) {
      if (listed.ticketKey !== ticketKey && !keys.includes(listed.ticketKey)) keys.push(listed.ticketKey);
    }
  }
  for (const key of keys) {
    const { files } = port(['download', key, '--out', join(scratch, key)]);
    const plan = lib.lastPlan(
      files
        .filter((each) => each.path !== undefined)
        .map((each) => ({ name: each.name, text: readFileSync(each.path, 'utf8') })),
    );
    if (plan === undefined) {
      answer.notes.push(`${key}: no plan attached`);
      continue;
    }
    const shared = lib.sharedPaths(mine, lib.planPaths(plan.text, parseTasks));
    answer.compared.push({ ticketKey: key, attachedAt: plan.attachedAt, shared });
  }
  for (const candidate of lib.byRecency(answer.compared)) {
    const waits = waitsOn(candidate.ticketKey);
    if (waits === 'free') {
      answer.blockedBy = candidate.ticketKey;
      answer.shared = candidate.shared;
      answer.why = lib.why(candidate.shared);
      break;
    }
    answer.notes.push(
      waits === 'waits'
        ? `${candidate.ticketKey}: already waits on ${ticketKey}`
        : `${candidate.ticketKey}: its prerequisites run past ${MAX_WALK} tickets`,
    );
  }
}
console.log(JSON.stringify(answer));
