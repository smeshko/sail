// Scans the lines the patch in $INPUT_DIFF adds, file by file with their line numbers, for two things committed text
// must not name in a public repository: a tracker key (`ABC-123`) of any prefix but those ALLOWED, and each term of the
// denylist, one per line, matched whole-word and case-insensitively. The denylist lives outside git, at
// `$SAIL_HOME/leak-denylist.txt` (`~/.sail/leak-denylist.txt` by default); without it, only keys are scanned for.
// Jev also checks added comment, doc and commit-message lines. Prints the Leaks.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const { LEAK_YES, leakLines, commitLines, leakState, leakQuestions, askNouls, yesses, git } = await import(
  join(dirname(process.env.SAIL_CONFIG), 'lib', 'jev-check.mjs')
);

/** Prefixes that look like tracker keys but are sail's own, or no tracker's at all. */
const ALLOWED = new Set(['ADW', 'FAKE', 'ADR', 'TASK', 'UTF', 'SHA', 'ISO', 'RFC']);
const KEY = /\b([A-Z][A-Z]{1,9})-\d+\b/g;

const home = process.env.SAIL_HOME || join(homedir(), '.sail');
const listed = join(home, 'leak-denylist.txt');
const terms = existsSync(listed)
  ? readFileSync(listed, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
  : [];
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const denied = terms.map((term) => ({ term, pattern: new RegExp(`(?<![\\w-])${literal(term)}(?![\\w-])`, 'i') }));

const hits = [];
let file = '';
let line = 0;
const diff = readFileSync(process.env.INPUT_DIFF, 'utf8');
for (const text of diff.split('\n')) {
  if (text.startsWith('+++ ')) {
    file = text === '+++ /dev/null' ? '' : text.slice(4).replace(/^b\//, '');
    continue;
  }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
  if (hunk) {
    line = Number(hunk[1]);
    continue;
  }
  if (text.startsWith('-') || text.startsWith('\\')) continue;
  if (text.startsWith('+') && file !== '') {
    const added = text.slice(1);
    for (const [match, prefix] of added.matchAll(KEY)) {
      if (!ALLOWED.has(prefix)) hits.push({ file, line, match, kind: 'key' });
    }
    for (const { term, pattern } of denied)
      if (pattern.test(added)) hits.push({ file, line, match: term, kind: 'denylist' });
  }
  line++;
}
const base = readFileSync(process.env.INPUT_BASE, 'utf8').trim();
const lines = [...leakLines(diff), ...commitLines(git(['log', '--format=%h%x00%B%x1e', `${base}..HEAD`]))];
const answer = lines.length
  ? askNouls(leakQuestions(lines), leakState(lines), process.env.STAGE_OUT)
  : { asked: false, note: 'no comment, doc or commit-message line added' };
let count = 0;
if (answer.asked) {
  for (const { id, yes } of yesses(
    answer.answers,
    lines.map((_, i) => `leak-${i + 1}`),
  )) {
    if (yes < LEAK_YES) continue;
    const item = lines[Number(id.slice(5)) - 1];
    hits.push({ file: item.file, line: item.line, match: item.text.trim().slice(0, 200), kind: 'jev', yes });
    count++;
  }
}
const note = answer.asked ? '' : answer.note;
const jev = { asked: answer.asked, note, threshold: LEAK_YES, lines: lines.length };
process.stderr.write(
  `${hits.length} hit${hits.length === 1 ? '' : 's'}; denylist: ${terms.length > 0 ? listed : 'none'}; jev: ${answer.asked ? `${lines.length} asked, ${count} over ${LEAK_YES}` : `not asked (${note})`}\n`,
);
console.log(JSON.stringify({ hits, denylist: terms.length > 0 ? listed : null, jev }));
