// Files the follow-ups in $INPUT_FOLLOWUPS as tickets, bugs first, at most MAX_FILED of them: the rest are noted on the
// pull request, not filed. Before filing, `sail port jev ask` checks each follow-up against open tickets and earlier
// follow-ups in groups bounded by question count and serialized bytes; duplicates are skipped. When Jev can't be asked, as in a repository
// with no Jev adapter, every follow-up is filed unchecked. A ticket gets its type as a label, `code-review` too for a
// deferred review finding, and `groom`, so the groom workflow judges whether it earns its place; never the factory's
// designation label, which would hand it to the next run. Each description ends with how the problem is reached and
// where it came from. A pull request comment then lists the tickets, duplicates, notes and failures. Prints
// the Filed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { wrapAll } = await import(pathToFileURL(join(dirname(process.env.SAIL_CONFIG), 'lib', 'untrusted.mjs')).href);
const { openTickets, excerpt, sameWork, SAME_WORK, MAX_QUESTIONS, MAX_REQUEST_BYTES } = await import(
  pathToFileURL(join(dirname(process.env.SAIL_CONFIG), 'lib', 'duplicates.mjs')).href
);

/** The most tickets one run files: a run that finds more has found mostly small things. */
const MAX_FILED = 2;

const read = (name) => readFileSync(process.env[name], 'utf8');
const { followUps } = JSON.parse(read('INPUT_FOLLOWUPS'));
const pr = JSON.parse(read('INPUT_PR'));
const origin = read('INPUT_ORIGIN');
const scratch = mkdtempSync(join(tmpdir(), 'follow-ups-'));

/** Runs `sail port …`, with the body in a file when there is one: its one line of JSON, or the error it printed. */
function port(args, body) {
  const bodyArgs = [];
  if (body !== undefined) {
    const bodyFile = join(scratch, 'body.md');
    writeFileSync(bodyFile, body);
    bodyArgs.push('--body-file', bodyFile);
  }
  const result = spawnSync('sail', ['port', ...args, ...bodyArgs], { encoding: 'utf8' });
  if (result.status === 0) return { answer: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
  return { error: (result.stderr || result.error?.message || `exit ${result.status}`).trim() };
}

/**
 * Open and earlier batch twins for each follow-up: requests bounded by questions and UTF-8 bytes. Throws when the
 * tickets can't be listed or Jev can't be asked, and the caller files unchecked.
 */
function duplicatesOf(candidates) {
  const open = openTickets();
  if (candidates.length === 0 || (open.length === 0 && candidates.length < 2)) return new Map();
  const passages = [
    ...candidates.flatMap((each, index) => [
      { text: excerpt(each.title), source: `follow-up ${index + 1}, title` },
      { text: excerpt(each.description), source: `follow-up ${index + 1}, description` },
    ]),
    ...open.flatMap((ticket) => [
      { text: excerpt(ticket.title), source: `ticket ${ticket.ticketKey}, title` },
      { text: excerpt(ticket.description || '(none)'), source: `ticket ${ticket.ticketKey}, description` },
    ]),
  ];
  const wrapped = wrapAll(passages);
  let next = 0;
  const entry = () => ({ title: wrapped[next++], description: wrapped[next++] });
  const state = {
    followUps: Object.fromEntries(candidates.map((_, index) => [`follow-up-${index + 1}`, entry()])),
    tickets: Object.fromEntries(open.map((ticket) => [ticket.ticketKey, entry()])),
  };
  const pairs = [];
  candidates.forEach((_, index) => {
    const a = `follow-up-${index + 1}`;
    for (const ticket of open) pairs.push({ name: `${a}:${ticket.ticketKey}`, a, b: ticket.ticketKey });
    for (let earlier = 0; earlier < index; earlier++) {
      const b = `follow-up-${earlier + 1}`;
      pairs.push({ name: `${a}:${b}`, a, b });
    }
  });
  const answers = {};
  const empty = () => ({ state: { followUps: {}, tickets: {} }, questions: {} });
  let request = empty();
  const ask = () => {
    const { answer, error } = port(['jev', 'ask'], JSON.stringify(request));
    if (error !== undefined) throw new Error(error);
    Object.assign(answers, answer.answers);
  };
  for (const { name, a, b } of pairs) {
    const collection = Object.hasOwn(state.followUps, b) ? 'followUps' : 'tickets';
    const add = () => {
      const next = {
        state: { followUps: { ...request.state.followUps }, tickets: { ...request.state.tickets } },
        questions: { ...request.questions, [name]: sameWork(`followUps["${a}"]`, `${collection}["${b}"]`) },
      };
      next.state.followUps[a] = state.followUps[a];
      next.state[collection][b] = state[collection][b];
      return next;
    };
    let next = add();
    if (
      Object.keys(next.questions).length > MAX_QUESTIONS ||
      Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_REQUEST_BYTES
    ) {
      if (Object.keys(request.questions).length > 0) ask();
      request = empty();
      next = add();
    }
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_REQUEST_BYTES)
      throw new Error('one duplicate-check pair exceeds the Jev request byte limit');
    request = next;
  }
  if (Object.keys(request.questions).length > 0) ask();
  const found = new Map();
  candidates.forEach((_, index) => {
    for (const ticket of open) {
      const yes = answers[`follow-up-${index + 1}:${ticket.ticketKey}`]?.noul ?? 0;
      if (yes >= SAME_WORK && yes > (found.get(index)?.open?.confidence ?? 0)) {
        found.set(index, {
          ...found.get(index),
          open: { ticketKey: ticket.ticketKey, url: ticket.url, confidence: yes },
        });
      }
    }
    for (let earlier = 0; earlier < index; earlier++) {
      const yes = answers[`follow-up-${index + 1}:follow-up-${earlier + 1}`]?.noul ?? 0;
      if (yes >= SAME_WORK) {
        const match = found.get(index) ?? {};
        match.batch ??= [];
        match.batch.push({ index: earlier, confidence: yes });
        found.set(index, match);
      }
    }
  });
  return found;
}

// Bugs first, the rest in the order given; past MAX_FILED, a follow-up is noted.
const ordered = [
  ...followUps.filter((each) => each.type === 'bug'),
  ...followUps.filter((each) => each.type !== 'bug'),
];
const noted = [];

let same = new Map();
let unchecked = null;
try {
  same = duplicatesOf(ordered);
} catch (error) {
  unchecked = error.message.split('\n')[0];
  process.stderr.write(`filing unchecked, the duplicate check failed: ${unchecked}\n`);
}

const filed = [];
const skipped = [];
const skipLinks = [];
const resolved = [];
const failed = [];
let slots = 0;
ordered.forEach(({ title, description, type, trigger, fromReview }, index) => {
  const body = `${description}\n\nReached by: ${trigger}\n\nFrom ${origin}: ${pr.url}`;
  const matches = same.get(index);
  const batch = matches?.batch?.filter((each) => resolved[each.index]).sort((a, b) => b.confidence - a.confidence)[0];
  const twin = matches?.open ?? (batch && { ...resolved[batch.index], confidence: batch.confidence });
  if (twin !== undefined) {
    if (matches?.open) {
      const { error } = port(
        ['ticket-source', 'comment', twin.ticketKey],
        `${origin} found this again (${pr.url}), and it was not filed as a ticket of its own:\n\n**${title}**\n\n${description}\n\nReached by: ${trigger}\n`,
      );
      if (error !== undefined) process.stderr.write(`comment on ${twin.ticketKey} failed: ${error}\n`);
    }
    skipped.push({ title, duplicateOf: twin.ticketKey, confidence: twin.confidence });
    skipLinks.push({ title, ticketKey: twin.ticketKey, url: twin.url });
    resolved[index] = twin;
    process.stderr.write(`duplicate of ${twin.ticketKey} (${twin.confidence.toFixed(2)}), not filed: ${title}\n`);
    return;
  }
  if (slots >= MAX_FILED) {
    noted.push({ title });
    return;
  }
  slots++;
  const labels = [type, ...(fromReview ? ['code-review'] : []), 'groom'].flatMap((label) => ['--label', label]);
  const { answer, error } = port(['ticket-source', 'create', '--title', title, ...labels], body);
  if (answer) {
    filed.push({ title, ticketKey: answer.ticketKey, url: answer.url });
    resolved[index] = { ticketKey: answer.ticketKey, url: answer.url };
  } else failed.push({ title, error });
  process.stderr.write(answer ? `filed ${answer.ticketKey}: ${title}\n` : `failed: ${title}: ${error}\n`);
});

if (followUps.length > 0) {
  const lines = [
    'Follow-ups:',
    '',
    ...filed.map((each) => `- [${each.ticketKey}](${each.url}) ${each.title}`),
    ...skipLinks.map((each) => `- duplicate of [${each.ticketKey}](${each.url}), not filed: ${each.title}`),
    ...noted.map((each) => `- noted, not filed (over ${MAX_FILED} per run): ${each.title}`),
    ...failed.map((each) => `- not filed: ${each.title} (${each.error.split('\n')[0]})`),
    ...(unchecked === null ? [] : ['', `Filed without the duplicate check, which failed: ${unchecked}`]),
  ];
  const { error } = port(['codehost', 'comment', String(pr.number)], `${lines.join('\n')}\n`);
  if (error) process.stderr.write(`the pull request comment failed: ${error}\n`);
}
console.log(JSON.stringify({ filed, skipped, noted, failed, unchecked }));
