// Checks that the tests still match what the tests commit locked, and that no sticker is left. From the tests commit a
// test file changes in exactly two ways: a sticker line is deleted, or a `test(<scope>): amend …` commit rewrites it.
// The working tree is what gets checked. Whitespace and trailing commas are ignored, so `bun run fix` reflowing a file
// after a sticker deletion passes. Prints one JSON line: { violations, amendments }.
// Usage: bun .sail/lib/check-tests.mjs <tests-commit>
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, isTestPath, STICKER, stickerLines } from './stickers.mjs';

const root = process.cwd();
const testsCommit = process.argv[2];
if (testsCommit === undefined) {
  console.error('usage: check-tests.mjs <tests-commit>');
  process.exit(2);
}

const changedIn = (sha) =>
  git(root, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', sha])
    .stdout.split('\n')
    .filter(Boolean);

// The files the tests commit and the test commits right before it touched. The stubs commit isn't one: its src/ files
// are what implement changes.
const locked = new Set();
for (const entry of git(root, ['log', '--first-parent', '--format=%H%x09%s', testsCommit]).stdout.split('\n')) {
  const [sha, subject = ''] = entry.split('\t');
  if (!sha || !/^test(\([^)]*\))?!?:/.test(subject)) break;
  for (const path of changedIn(sha)) locked.add(path);
}

// Amend commits after the tests commit, and each path's latest one, which becomes its baseline.
const amendments = [];
const amendedAt = new Map();
for (const entry of git(root, ['log', '--format=%H%x09%s', `${testsCommit}..HEAD`]).stdout.split('\n')) {
  const [sha, subject = ''] = entry.split('\t');
  if (!sha || !/^test(\([^)]*\))?!?: amend\b/.test(subject)) continue;
  amendments.unshift(`${sha.slice(0, 10)} ${subject}`);
  for (const path of changedIn(sha)) if (!amendedAt.has(path)) amendedAt.set(path, sha);
}

const blob = (sha, path) => {
  const shown = git(root, ['show', `${sha}:${path}`], { check: false });
  return shown.status === 0 ? shown.stdout : null;
};
const working = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null);
const stickers = (text) =>
  new Set(
    text
      .split('\n')
      .filter((line) => line.includes(STICKER))
      .map((line) => line.trim()),
  );
const normalized = (text) =>
  text
    .split('\n')
    .filter((line) => !line.includes(STICKER))
    .join('')
    .replace(/\s+/g, '')
    .replace(/,([)\]}])/g, '$1');

const changed = new Set([
  ...git(root, ['diff', '--name-only', '--no-renames', testsCommit]).stdout.split('\n'),
  ...git(root, ['ls-files', '--others', '--exclude-standard']).stdout.split('\n'),
]);
const violations = [];
for (const path of [...changed].filter(Boolean).sort()) {
  if (!locked.has(path) && !isTestPath(path)) continue;
  const base = blob(amendedAt.get(path) ?? testsCommit, path);
  const now = working(path);
  if (base === null && now === null) continue;
  if (base === null) violations.push(`added: ${path}`);
  else if (now === null) violations.push(`deleted: ${path}`);
  else if ([...stickers(now)].some((line) => !stickers(base).has(line))) violations.push(`sticker added: ${path}`);
  else if (normalized(now) !== normalized(base)) violations.push(`edited: ${path}`);
}
for (const line of stickerLines(root)) violations.push(`pending: ${line}`);

console.log(JSON.stringify({ violations, amendments }));
