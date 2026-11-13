// Find added uses of CONTEXT.md's avoided words on the diff's added lines, never in commit messages; Jev judges every candidate in a request of its own, with two nouls, four requests at a time, stopping at a failed request or its time limit, leaving out a line the diff also removes (moved or re-wrapped), a JS keyword on a code line outside its string literals and comments and occurrences after the third of a word in one file (one hit per file, on its highest-scoring line), and counting what it didn't ask.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const {
  BANNED_YES,
  BANNED_REFERS,
  parseGlossary,
  bannedLines,
  bannedCandidates,
  bannedSelect,
  bannedRemoved,
  bannedHits,
  bannedRequests,
  bannedAsk,
  askNoulsAsync,
} = await import(join(dirname(process.env.SAIL_CONFIG), 'lib', 'jev-check.mjs'));
const present = existsSync('CONTEXT.md');
const entries = present ? parseGlossary(readFileSync('CONTEXT.md', 'utf8')) : [];
const diff = readFileSync(process.env.INPUT_DIFF, 'utf8');
const lines = bannedLines(diff);
const allCandidates = bannedCandidates(lines, entries);
const { selected, keyword, moved, repeat } = bannedSelect(allCandidates, bannedRemoved(diff));
const { requests, asked, oversized } = bannedRequests(selected);
const { results, unasked, reason } = await bannedAsk(requests, ({ state, questions }, i) =>
  askNoulsAsync(questions, state, process.env.STAGE_OUT, i === 0 ? 'jev-request.json' : `jev-request-${i + 1}.json`),
);
const refused = results.filter((result) => !result.asked);
const notAskedRequests = refused.length + unasked;
const answer = !requests.length
  ? { asked: false, note: allCandidates.length ? '' : present ? 'no avoided word on an added line' : 'no CONTEXT.md' }
  : refused.length === results.length
    ? { asked: false, failed: refused[0].failed, note: refused[0].note }
    : {
        asked: true,
        answers: Object.assign({}, ...results.map((result) => result.answers ?? {})),
        note: notAskedRequests
          ? `${notAskedRequests} of ${requests.length} requests not asked: ${refused[0]?.note ?? reason}`
          : '',
      };
const note = oversized ? `${oversized} candidates omitted (request limits)` : '';
const hits = answer.asked ? bannedHits(asked, answer.answers) : [];
const glossary = { entries: entries.length, words: entries.reduce((sum, entry) => sum + entry.avoid.length, 0) };
const jev = {
  asked: answer.asked,
  failed: answer.failed === true,
  note: [answer.note, note].filter(Boolean).join('; '),
  threshold: BANNED_YES,
  candidates: allCandidates.length,
  requests: requests.length,
  skipped: { keyword, moved, repeat, oversized },
};
const notAsked = [
  keyword && `${keyword} keyword`,
  moved && `${moved} moved`,
  repeat && `${repeat} repeat`,
  oversized && `${oversized} over the request limit`,
]
  .filter(Boolean)
  .join(', ');
process.stderr.write(
  `${hits.length} hits; glossary: ${glossary.entries} entries, ${glossary.words} words; jev: ${answer.asked ? `${asked.length} asked in ${requests.length} request(s), ${hits.length} flagged (${BANNED_YES} and ${BANNED_REFERS})${notAsked ? `; not asked: ${notAsked}` : ''}${answer.note ? `; ${answer.note}` : ''}` : `not asked (${jev.note})`}\n`,
);
console.log(JSON.stringify({ hits, glossary, jev }));
