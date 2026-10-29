// Files the follow-ups in $INPUT_FOLLOWUPS as tickets, bugs first, at most MAX_FILED of them: the rest are noted on the
// pull request, not filed. Before filing, one `sail port jev ask` checks each follow-up against open tickets and earlier
// follow-ups; duplicates are skipped. When Jev can't be asked, as in a repository
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

const { openTickets, wrap, excerpt, sameWork, SAME_WORK } = await import(
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
 * Open and earlier batch twins for each follow-up, with Jev's answers: one request for every pair. Throws when the
 * tickets can't be listed or Jev can't be asked, and the caller files unchecked.
 */
function duplicatesOf(candidates) {
  const open = openTickets();
  if (candidates.length === 0 || (open.length === 0 && candidates.length < 2)) return new Map();
  const state = {
    followUps: Object.fromEntries(
      candidates.map((each, index) => [
        `follow-up-${index + 1}`,
        {
          title: wrap(each.title, `follow-up ${index + 1}, title`),
          description: wrap(each.description, `follow-up ${index + 1}, description`),
        },
      ]),
    ),
    tickets: Object.fromEntries(
      open.map((ticket) => [
        ticket.ticketKey,
        {
          title: wrap(ticket.title, `ticket ${ticket.ticketKey}, title`),
          description: wrap(excerpt(ticket.description || '(none)'), `ticket ${ticket.ticketKey}, description`),
        },
      ]),
    ),
  };
  const questions = {};
  candidates.forEach((_, index) => {
    for (const ticket of open) {
      questions[`follow-up-${index + 1}:${ticket.ticketKey}`] = sameWork(
        `followUps["follow-up-${index + 1}"]`,
        `tickets["${ticket.ticketKey}"]`,
      );
    }
    for (let earlier = 0; earlier < index; earlier++) {
      questions[`follow-up-${index + 1}:follow-up-${earlier + 1}`] = sameWork(
        `followUps["follow-up-${index + 1}"]`,
        `followUps["follow-up-${earlier + 1}"]`,
      );
    }
  });
  const { answer, error } = port(['jev', 'ask'], JSON.stringify({ state, questions }));
  if (error !== undefined) throw new Error(error);
  const found = new Map();
  candidates.forEach((_, index) => {
    for (const ticket of open) {
      const yes = answer.answers[`follow-up-${index + 1}:${ticket.ticketKey}`]?.noul ?? 0;
      if (yes >= SAME_WORK && yes > (found.get(index)?.open?.confidence ?? 0)) {
        found.set(index, {
          ...found.get(index),
          open: { ticketKey: ticket.ticketKey, url: ticket.url, confidence: yes },
        });
      }
    }
    for (let earlier = 0; earlier < index; earlier++) {
      const yes = answer.answers[`follow-up-${index + 1}:follow-up-${earlier + 1}`]?.noul ?? 0;
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
