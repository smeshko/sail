// What the factory's scripts share about pending tests: the sticker, which paths count as test files, and git.
//
// A sticker is a line holding `TDD-PENDING <task-id>` that keeps a test skipped. In sail it takes two lines, both
// tagged, because Bun has no runtime skip and Biome reflows a `test.skip` chain:
//
//   // biome-ignore format: TDD-PENDING TASK-005
//   test
//     .skip // TDD-PENDING TASK-005
//     ('name', async () => { … });
//
// Deleting both lines, and nothing else, makes the test run; `bun run fix` then folds `test\n  (…)` back together.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STICKER = 'TDD-PENDING';

/** Test files, by path: anything under test/, and any *.test.* file. Fixtures and helpers under test/ are locked too. */
export const isTestPath = (path) => /^test\//.test(path) || /\.test\.\w+$/.test(path);

/** The paths a sticker search skips: this folder mentions the sticker, and docs/ holds plans. */
const EXCLUDED = [':(exclude).sail/', ':(exclude)docs/'];

export function git(root, args, { check = true } = {}) {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8' });
  if (check && result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result;
}

/** Every file, tracked or untracked and not ignored, that holds a sticker line. */
export function filesWithStickers(root) {
  const found = git(root, ['grep', '-l', '-I', '--untracked', '-F', STICKER, '--', '.', ...EXCLUDED], { check: false });
  if (found.status !== 0 && found.status !== 1) throw new Error(`git grep: ${found.stderr.trim()}`);
  return found.stdout.split('\n').filter(Boolean);
}

/** Every sticker line left: `path:line: text`. */
export function stickerLines(root) {
  const found = git(root, ['grep', '-n', '-I', '--untracked', '-F', STICKER, '--', '.', ...EXCLUDED], { check: false });
  return found.stdout.split('\n').filter(Boolean);
}

/** Deletes the sticker lines of one task, or of every task, from the given files. Returns how many it deleted. */
export function strip(root, paths, task) {
  const line = task === undefined ? new RegExp(STICKER) : new RegExp(`${STICKER} ${task}\\b`);
  let total = 0;
  for (const path of paths) {
    const lines = readFileSync(join(root, path), 'utf8').split(/(?<=\n)/);
    const kept = lines.filter((each) => !line.test(each));
    if (kept.length === lines.length) continue;
    writeFileSync(join(root, path), kept.join(''));
    total += lines.length - kept.length;
  }
  return total;
}

/** The last lines of a log, so a report carries what failed without the whole run. */
export const tail = (text, lines = 80) => text.split('\n').slice(-lines).join('\n').slice(-8000);
