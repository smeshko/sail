// Commits every change in the workspace in two commits: whatever isn't a test file as the stubs, then the test files
// as the tests commit. Stages each path by name.
import { readFileSync } from 'node:fs';
import { git, isTestPath } from '../../../../lib/stickers.mjs';

const root = process.cwd();
const { ticketKey, slug, scope } = JSON.parse(readFileSync(process.env.INPUT_COMMIT, 'utf8'));

// `git status -z`: each entry is `XY path`, and a rename's source follows it as an entry of its own.
const entries = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout.split('\0');
const changed = [];
for (let at = 0; at < entries.length; at += 1) {
  const entry = entries[at];
  if (entry === '') continue;
  changed.push(entry.slice(3));
  if (entry[0] === 'R' || entry[0] === 'C') changed.push(entries[++at]);
}

const commit = (paths, subject) => {
  git(root, ['add', '--', ...paths]);
  git(root, ['commit', '--quiet', '-m', `${subject} (${ticketKey})`]);
  return git(root, ['rev-parse', 'HEAD']).stdout.trim();
};

const stubs = changed.filter((path) => !isTestPath(path));
const tests = changed.filter(isTestPath);
if (tests.length === 0) {
  console.error('no test file changed: there is nothing to lock');
  process.exit(2);
}
const stubsCommit = stubs.length === 0 ? null : commit(stubs, `chore(${scope}): add stubs for ${slug}`);
const testsCommit = commit(tests, `test(${scope}): add pending tests for ${slug}`);
console.error(`stubs: ${stubs.join(', ') || 'none'}\ntests: ${tests.join(', ')}`);
console.log(JSON.stringify({ stubsCommit, testsCommit }));
