// A copy of the fixture repository's `.sail/` for one test to edit. Bun caches modules by path, so a test that edits a
// definition and imports it needs a copy of its own.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const FIXTURE_SAIL = join(import.meta.dir, '..', 'fixtures', 'repo', '.sail');

/** Copies the fixture's `.sail/` into `repoDir`, and returns the copy. */
export function copyFixture(repoDir: string): string {
  const sail = join(repoDir, '.sail');
  cpSync(FIXTURE_SAIL, sail, { recursive: true });
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
