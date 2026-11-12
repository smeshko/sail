// Scans the lines the patch in $INPUT_DIFF adds, file by file with their line numbers, for two things committed text
// must not name in a public repository: a tracker key (`ABC-123`) of any prefix but those ALLOWED, in any file outside
// test/, where the tests' placeholder keys live, and each term of the
// denylist, one per line, matched whole-word and case-insensitively. The denylist lives outside git, at
// `$SAIL_HOME/leak-denylist.txt` (`~/.sail/leak-denylist.txt` by default); without it, only keys are scanned for.
// Jev also checks added comment, doc and commit-message lines. Prints the Leaks: every hit, and the groups they come to,
// one per tracker-key prefix, one per denylist term (never named) and one per Jev line, each with its count, its number of
// files and up to five examples. Every location is also written to `leak-locations.txt` in $STAGE_OUT, one
// `L<n><TAB><file>:<line>` line per hit, n being the group's place, which is its finding's id.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const { LEAK_YES, leakLines, commitLines, leakRequests, askNouls, yesses, git } = await import(
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
const keyOf = [];
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
    for (const [match, prefix] of file.startsWith('test/') ? [] : added.matchAll(KEY)) {
      if (!ALLOWED.has(prefix)) {
        hits.push({ file, line, match, kind: 'key' });
        keyOf.push(`key:${prefix}`);
      }
    }
    for (const { term, pattern } of denied)
      if (pattern.test(added)) {
        hits.push({ file, line, match: term, kind: 'denylist' });
        keyOf.push(`denylist:${term}`);
      }
  }
  line++;
}
const base = readFileSync(process.env.INPUT_BASE, 'utf8').trim();
const lines = [...leakLines(diff), ...commitLines(git(['log', '--format=%h%x00%B%x1e', `${base}..HEAD`]))];
// Each request fits Jev's byte limit, so a large change is asked about in several; the answers of those asked are kept.
const requests = leakRequests(lines);
const results = requests.map(({ state, questions }, i) =>
  askNouls(questions, state, process.env.STAGE_OUT, i === 0 ? 'jev-request.json' : `jev-request-${i + 1}.json`),
);
const refused = results.filter((result) => !result.asked);
const answer = !lines.length
  ? { asked: false, note: 'no comment, doc or commit-message line added' }
  : refused.length === results.length
    ? { asked: false, note: refused[0].note }
    : {
        asked: true,
        answers: Object.assign({}, ...results.map((result) => result.answers ?? {})),
        note: refused.length ? `${refused.length} of ${results.length} requests not asked: ${refused[0].note}` : '',
      };
let count = 0;
if (answer.asked) {
  for (const { id, yes } of yesses(
    answer.answers,
    lines.map((_, i) => `leak-${i + 1}`),
  )) {
    if (yes < LEAK_YES) continue;
    const item = lines[Number(id.slice(5)) - 1];
    hits.push({ file: item.file, line: item.line, match: item.text.trim().slice(0, 200), kind: 'jev', yes });
    keyOf.push(`jev:${hits.length}`);
    count++;
  }
}
const EXAMPLES = 5;
const groupIndex = new Map();
const groups = [];
const fileSets = [];
const locations = [];
for (const [i, hit] of hits.entries()) {
  let at = groupIndex.get(keyOf[i]);
  if (at === undefined) {
    at = groups.length;
    groupIndex.set(keyOf[i], at);
    groups.push({
      kind: hit.kind,
      ...(hit.kind === 'key' ? { prefix: keyOf[i].slice(4) } : {}),
      count: 0,
      files: 0,
      examples: [],
      ...(hit.kind === 'jev' ? { yes: hit.yes } : {}),
    });
    fileSets.push(new Set());
  }
  const group = groups[at];
  group.count++;
  fileSets[at].add(hit.file);
  group.files = fileSets[at].size;
  if (group.examples.length < EXAMPLES)
    group.examples.push({ file: hit.file, line: hit.line, ...(hit.kind === 'denylist' ? {} : { match: hit.match }) });
  locations.push(`L${at + 1}\t${hit.file}:${hit.line}\n`);
}
writeFileSync(join(process.env.STAGE_OUT, 'leak-locations.txt'), locations.join(''));
const note = answer.note;
const jev = {
  asked: answer.asked,
  failed: results.some((result) => result.failed === true),
  note,
  threshold: LEAK_YES,
  lines: lines.length,
};
process.stderr.write(
  `${hits.length} hit${hits.length === 1 ? '' : 's'} in ${groups.length} group${groups.length === 1 ? '' : 's'}; denylist: ${terms.length > 0 ? listed : 'none'}; jev: ${answer.asked ? `${lines.length} lines in ${requests.length} request${requests.length === 1 ? '' : 's'}, ${count} over ${LEAK_YES}${note ? `; ${note}` : ''}` : `not asked (${note})`}\n`,
);
console.log(JSON.stringify({ hits, groups, denylist: terms.length > 0 ? listed : null, jev }));
