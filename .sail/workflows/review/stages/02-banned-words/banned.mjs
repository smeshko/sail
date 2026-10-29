// Find added uses of CONTEXT.md's avoided words; Jev judges a bounded request, reporting omissions.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const {
  BANNED_YES,
  parseGlossary,
  bannedLines,
  messageContext,
  commitLines,
  bannedCandidates,
  bannedRequest,
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
const { candidates, questions, state, note } = bannedRequest(allCandidates);
const answer = candidates.length
  ? askNouls(questions, state, process.env.STAGE_OUT)
  : { asked: false, note: allCandidates.length ? '' : present ? 'no avoided word on an added line' : 'no CONTEXT.md' };
const hits = [];
if (answer.asked) {
  for (const { id, yes } of yesses(
    answer.answers,
    candidates.map((_, i) => `word-${i + 1}`),
  )) {
    if (yes < BANNED_YES) continue;
    const { file, line, word, term } = candidates[Number(id.slice(5)) - 1];
    hits.push({ file, line, word, term, yes });
  }
}
const glossary = { entries: entries.length, words: entries.reduce((sum, entry) => sum + entry.avoid.length, 0) };
const jev = {
  asked: answer.asked,
  note: [answer.asked ? '' : answer.note, note].filter(Boolean).join('; '),
  threshold: BANNED_YES,
  candidates: allCandidates.length,
};
process.stderr.write(
  `${hits.length} hits; glossary: ${glossary.entries} entries, ${glossary.words} words; jev: ${answer.asked ? `${candidates.length} asked, ${hits.length} over ${BANNED_YES}${note ? `; ${note}` : ''}` : `not asked (${jev.note})`}\n`,
);
console.log(JSON.stringify({ hits, glossary, jev }));
