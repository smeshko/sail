// Deletes TDD-PENDING sticker lines so pending tests run: every sticker, or with --task only that task's. Nothing
// else in a file changes, which is exactly the edit check-tests allows. Prints `stripped=<n>`.
// Usage: bun .sail/lib/strip-stickers.mjs [--task TASK-003]
import { filesWithStickers, strip } from './stickers.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--task');
const task = at === -1 ? undefined : args[at + 1];
if (task !== undefined && !/^TASK-\d+$/.test(task)) {
  console.error(`--task must look like TASK-003, got ${task}`);
  process.exit(2);
}
console.log(`stripped=${strip(process.cwd(), filesWithStickers(process.cwd()), task)}`);
