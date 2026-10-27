// Scans the lines the patch in $INPUT_DIFF adds, file by file with their line numbers, for two things committed text
// must not name in a public repository: a tracker key (`ABC-123`) of any prefix but those ALLOWED, and each term of the
// denylist, one per line, matched whole-word and case-insensitively. The denylist lives outside git, at
// `$SAIL_HOME/leak-denylist.txt` (`~/.sail/leak-denylist.txt` by default); without it, only keys are scanned for.
// Prints the Leaks.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
for (const text of readFileSync(process.env.INPUT_DIFF, 'utf8').split('\n')) {
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
process.stderr.write(
  `${hits.length} hit${hits.length === 1 ? '' : 's'}; denylist: ${terms.length > 0 ? listed : 'none'}\n`,
);
console.log(JSON.stringify({ hits, denylist: terms.length > 0 ? listed : null }));
