// The running sail's SDK version, as the declarations it type-checks against, and the refusal a dispatched start prints
// when the `.sail/` committed at the default branch needs a newer one. The format is written and read here only, so the
// child that refuses and the watcher that holds on it can't drift.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from './typecheck';

/** The running sail's committed declarations. */
export const SDK_DIR = join(PACKAGE_ROOT, 'types');

/** A hash of every `*.d.ts` in `typesDir`, by name: it changes when the running sail's SDK does. */
export function sdkFingerprint(typesDir: string = SDK_DIR): string {
  const hash = createHash('sha256');
  for (const name of readdirSync(typesDir)
    .filter((file) => file.endsWith('.d.ts'))
    .sort()) {
    hash
      .update(`${name}\0`)
      .update(readFileSync(join(typesDir, name)))
      .update('\0');
  }
  return hash.digest('hex');
}

/** The running sail's package name. */
export function sailPackageName(): string {
  return (JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { name: string }).name;
}

/** The refusal's message: the commit's first 7 characters and the clone to pull. */
export function newerSailRefusal(sha: string, clone: string): string {
  return `definitions at ${sha.slice(0, 7)} need a newer sail: pull ${clone}`;
}

/** What `newerSailRefusal()` made, read back from a refusal's message; undefined for any other line. */
export function parseNewerSail(line: string): { sha7: string; clone: string } | undefined {
  const found = /^definitions at ([0-9a-f]{7}) need a newer sail: pull (.+)$/.exec(line);
  return found === null ? undefined : { sha7: found[1] ?? '', clone: found[2] ?? '' };
}
