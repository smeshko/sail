// A copy of the fixture repository's `.sail/` for one test to edit. Bun caches modules by path, so a test that edits a
// definition and imports it needs a copy of its own.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const FIXTURE_SAIL = join(import.meta.dir, '..', 'fixtures', 'repo', '.sail');

/** Copies the fixture's `.sail/` into `repoDir`, and returns the copy. */
export function copyFixture(repoDir: string): string {
  const sail = join(repoDir, '.sail');
  cpSync(FIXTURE_SAIL, sail, { recursive: true });
  return sail;
}

/**
 * Where `land` lives: the review operations demonstration (ADW-127), kept beside the fixture repository rather than in
 * it, so the fixture's roster and its golden run stay ticket-to-pr's alone.
 */
export const LAND_SAIL = join(import.meta.dir, '..', 'fixtures', 'land', '.sail');

/** Adds `land` to the copy `sail` of the fixture's `.sail/`, as `workflows/land/`, and returns `sail`. */
export function addLand(sail: string): string {
  cpSync(LAND_SAIL, sail, { recursive: true });
  return sail;
}

/** Writes `text` to `path` under `sail`, making its folder, and returns the file. */
export function write(sail: string, path: string, text: string): string {
  const file = join(sail, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** Replaces `from` with `to` in the file at `path` under `sail`, which must hold it, and returns the file. */
export function edit(sail: string, path: string, from: string, to: string): string {
  const file = join(sail, path);
  const text = readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`${path} has no ${from}`);
  writeFileSync(file, text.replace(from, to));
  return file;
}

const OPEN_SCRIPT = 'workflows/ticket-to-pr/stages/publish/open.sh';
const OPENED = '--body-file "$INPUT_BODY" --ticket "$ticket" --label sail)\n';

/**
 * Makes a copy's `open` step hold once `open-pull-request` has answered, in a run whose environment sets
 * `HOLD_AFTER_OPEN` to a file: the script writes its pid there, which leads its process group, and sleeps a minute. A
 * test waits for the file, kills the run and that group there, and resumes it. Without the variable it runs as it was.
 */
export function holdAfterOpen(sail: string): string {
  const file = join(sail, OPEN_SCRIPT);
  const text = readFileSync(file, 'utf8');
  if (text.split(OPENED).length !== 2) throw new Error(`${OPEN_SCRIPT} has no single open-pull-request answer`);
  // Spliced in with a function, not through edit(): a replacement string would read the shell's `$$` as one `$`.
  const hold = `if [ -n "\${HOLD_AFTER_OPEN:-}" ]; then echo "$$" >"$HOLD_AFTER_OPEN"; exec sleep 60; fi\n`;
  writeFileSync(
    file,
    text.replace(OPENED, () => `${OPENED}${hold}`),
  );
  return file;
}

const PUBLISH_OPEN = 'workflows/ticket-to-pr/stages/publish/open.sh';
const STRICT = 'set -euo pipefail\n';

/**
 * Makes a copy's `publish` stage hold as its `open` step starts, before it pushes, in a run whose environment sets
 * `HOLD_BEFORE_OPEN` to a file: the script writes its pid there, which leads its process group, and sleeps a minute.
 * `describe` is journaled by then, so a test that waits for the file and kills the run there resumes it between the
 * two steps. Without the variable the step runs as it was.
 */
export function holdBeforeOpen(sail: string): string {
  const file = join(sail, PUBLISH_OPEN);
  const text = readFileSync(file, 'utf8');
  if (text.split(STRICT).length !== 2) throw new Error(`${PUBLISH_OPEN} has no single ${STRICT.trim()}`);
  // Spliced in with a function, not through edit(): a replacement string would read the shell's `$$` as one `$`.
  const hold = `if [ -n "\${HOLD_BEFORE_OPEN:-}" ]; then echo "$$" >"$HOLD_BEFORE_OPEN"; exec sleep 60; fi\n`;
  writeFileSync(
    file,
    text.replace(STRICT, () => `${STRICT}${hold}`),
  );
  return file;
}

/**
 * Waits for the pid `holdAfterOpen()`'s step writes to `file`, then SIGKILLs `child`, the run, and that step's process
 * group, and waits for `child` to end. Answers whether the step was held: false when `child` ended first, or nothing
 * held within `timeoutMs`, and then nothing is killed but `child`.
 */
export async function killWhenHeld(file: string, child: Bun.Subprocess, timeoutMs = 30_000): Promise<boolean> {
  let ended = false;
  void child.exited.then(() => {
    ended = true;
  });
  const deadline = performance.now() + timeoutMs;
  const pid = () => (existsSync(file) ? Number(readFileSync(file, 'utf8').trim()) || undefined : undefined);
  while (pid() === undefined && !ended && performance.now() < deadline) await Bun.sleep(20);
  const held = pid();
  child.kill('SIGKILL');
  await child.exited;
  if (held === undefined) return false;
  try {
    process.kill(-held, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  return true;
}
