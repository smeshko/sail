// Find added uses of CONTEXT.md's avoided words; Jev judges every candidate in requests of 16, reporting what it didn't ask.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const {
  BANNED_YES,
  parseGlossary,
  bannedLines,
  messageContext,
  commitLines,
  bannedCandidates,
  bannedRequests,
  askNouls,
  yesses,
  git,
} = await import(join(dirname(process.env.SAIL_CONFIG), 'lib', 'jev-check.mjs'));
const present = existsSync('CONTEXT.md');
const entries = present ? parseGlossary(readFileSync('CONTEXT.md', 'utf8')) : [];
const diff = readFileSync(process.env.INPUT_DIFF, 'utf8');
const base = readFileSync(process.env.INPUT_BASE, 'utf8').trim();
const lines = [
  ...bannedLines(diff),
  ...messageContext(commitLines(git(['log', '--format=%h%x00%B%x1e', `${base}..HEAD`]))),
];
const allCandidates = bannedCandidates(lines, entries);
const { requests, asked, oversized } = bannedRequests(allCandidates);
const results = requests.map(({ state, questions }, i) =>
  askNouls(questions, state, process.env.STAGE_OUT, i === 0 ? 'jev-request.json' : `jev-request-${i + 1}.json`),
);
const refused = results.filter((result) => !result.asked);
const answer = !requests.length
  ? { asked: false, note: allCandidates.length ? '' : present ? 'no avoided word on an added line' : 'no CONTEXT.md' }
  : refused.length === results.length
    ? { asked: false, failed: refused[0].failed, note: refused[0].note }
    : {
        asked: true,
        answers: Object.assign({}, ...results.map((result) => result.answers ?? {})),
        note: refused.length ? `${refused.length} of ${results.length} requests not asked: ${refused[0].note}` : '',
      };
const note = oversized ? `${oversized} candidates omitted (request limits)` : '';
const hits = [];
if (answer.asked) {
  for (const { id, yes } of yesses(
    answer.answers,
    asked.map((_, i) => `word-${i + 1}`),
  )) {
    if (yes < BANNED_YES) continue;
    const { file, line, word, term } = asked[Number(id.slice(5)) - 1];
    hits.push({ file, line, word, term, yes });
  }
}
const glossary = { entries: entries.length, words: entries.reduce((sum, entry) => sum + entry.avoid.length, 0) };
const jev = {
  asked: answer.asked,
  failed: answer.failed === true,
  note: [answer.note, note].filter(Boolean).join('; '),
  threshold: BANNED_YES,
  candidates: allCandidates.length,
  requests: requests.length,
  skipped: { oversized },
};
process.stderr.write(
  `${hits.length} hits; glossary: ${glossary.entries} entries, ${glossary.words} words; jev: ${answer.asked ? `${asked.length} asked in ${requests.length} request(s), ${hits.length} over ${BANNED_YES}${oversized ? `; not asked: ${oversized} over the request limit` : ''}${answer.note ? `; ${answer.note}` : ''}` : `not asked (${jev.note})`}\n`,
);
console.log(JSON.stringify({ hits, glossary, jev }));
