// Files the follow-ups in $INPUT_FOLLOWUPS as tickets, bugs first, at most MAX_FILED of them: the rest are noted on the
// pull request, not filed. Before filing, one `sail port jev ask` checks each follow-up against the team's open tickets;
// one Jev answers at DUPLICATE or more is commented on that ticket instead. When Jev can't be asked, as in a repository
// with no Jev adapter, every follow-up is filed unchecked. A ticket gets its type as a label, `code-review` too for a
// deferred review finding, and `groom`, so the groom workflow judges whether it earns its place; never the factory's
// designation label, which would hand it to the next run. Each description ends with how the problem is reached and
// where it came from. A pull request comment then lists the tickets, the comments, the notes and the failures. Prints
// the Filed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The most tickets one run files: a run that finds more has found mostly small things. */
const MAX_FILED = 2;
/** Jev answers at or above this are the same work as an open ticket, which gets a comment instead of a twin. */
const DUPLICATE = 0.8;
/** The most of each open ticket's description the duplicate check carries. */
const DESCRIPTION_CHARS = 600;

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

/** Runs `sail port render --untrusted`: the text wrapped, or the error. */
function wrap(text, source) {
  const result = spawnSync('sail', ['port', 'render', '--untrusted', '--source', source], {
    encoding: 'utf8',
    input: text,
  });
  if (result.status !== 0) throw new Error((result.stderr || `exit ${result.status}`).trim());
  return result.stdout.trimEnd();
}

/**
 * The open ticket each follow-up is the same work as, by index, with Jev's answer: one request for every pair. Throws
 * when the tickets can't be listed or Jev can't be asked, and the caller files unchecked.
 */
function duplicatesOf(candidates) {
  const open = [];
  for (const state of ['unstarted', 'started']) {
    const { answer, error } = port(['ticket-source', 'list', '--state', state]);
    if (error !== undefined) throw new Error(error);
    open.push(...answer);
  }
  if (open.length === 0 || candidates.length === 0) return new Map();
  const excerpt = (text) => (text.length > DESCRIPTION_CHARS ? `${text.slice(0, DESCRIPTION_CHARS)}…` : text);
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
      questions[`follow-up-${index + 1}:${ticket.ticketKey}`] = {
        type: 'noul',
        instructions: `Do \`followUps["follow-up-${index + 1}"]\` and \`tickets["${ticket.ticketKey}"]\` describe the same work?`,
        criteria: {
          true: 'the same change: the same outcome in the same place, worded differently, or one is a step of the other',
          false: 'a different change, even in the same area',
        },
      };
    }
  });
  const { answer, error } = port(['jev', 'ask'], JSON.stringify({ state, questions }));
  if (error !== undefined) throw new Error(error);
  const found = new Map();
  candidates.forEach((_, index) => {
    for (const ticket of open) {
      const yes = answer.answers[`follow-up-${index + 1}:${ticket.ticketKey}`]?.noul ?? 0;
      if (yes >= DUPLICATE && yes > (found.get(index)?.confidence ?? 0)) {
        found.set(index, { ticketKey: ticket.ticketKey, confidence: yes });
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
const candidates = ordered.slice(0, MAX_FILED);
const noted = ordered.slice(MAX_FILED).map(({ title }) => ({ title }));

let same = new Map();
let unchecked = null;
try {
  same = duplicatesOf(candidates);
} catch (error) {
  unchecked = error.message.split('\n')[0];
  process.stderr.write(`filing unchecked, the duplicate check failed: ${unchecked}\n`);
}

const filed = [];
const existing = [];
const failed = [];
candidates.forEach(({ title, description, type, trigger, fromReview }, index) => {
  const body = `${description}\n\nReached by: ${trigger}\n\nFrom ${origin}: ${pr.url}`;
  const twin = same.get(index);
  if (twin !== undefined) {
    const { error } = port(
      ['ticket-source', 'comment', twin.ticketKey],
      `${origin} found this again (${pr.url}), and it was not filed as a ticket of its own:\n\n**${title}**\n\n${description}\n\nReached by: ${trigger}\n`,
    );
    if (error === undefined) {
      existing.push({ title, ticketKey: twin.ticketKey, confidence: twin.confidence });
      process.stderr.write(`commented on ${twin.ticketKey}: ${title}\n`);
    } else {
      failed.push({ title, error });
      process.stderr.write(`failed: ${title}: ${error}\n`);
    }
    return;
  }
  const labels = [type, ...(fromReview ? ['code-review'] : []), 'groom'].flatMap((label) => ['--label', label]);
  const { answer, error } = port(['ticket-source', 'create', '--title', title, ...labels], body);
  if (answer) filed.push({ title, ticketKey: answer.ticketKey, url: answer.url });
  else failed.push({ title, error });
  process.stderr.write(answer ? `filed ${answer.ticketKey}: ${title}\n` : `failed: ${title}: ${error}\n`);
});

if (followUps.length > 0) {
  const lines = [
    'Follow-ups:',
    '',
    ...filed.map((each) => `- [${each.ticketKey}](${each.url}) ${each.title}`),
    ...existing.map((each) => `- already ${each.ticketKey}, commented there: ${each.title}`),
    ...noted.map((each) => `- noted, not filed (over ${MAX_FILED} per run): ${each.title}`),
    ...failed.map((each) => `- not filed: ${each.title} (${each.error.split('\n')[0]})`),
    ...(unchecked === null ? [] : ['', `Filed without the duplicate check, which failed: ${unchecked}`]),
  ];
  const { error } = port(['codehost', 'comment', String(pr.number)], `${lines.join('\n')}\n`);
  if (error) process.stderr.write(`the pull request comment failed: ${error}\n`);
}
console.log(JSON.stringify({ filed, existing, noted, failed, unchecked }));
