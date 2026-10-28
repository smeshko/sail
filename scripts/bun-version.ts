// CI pins one Bun in .github/workflows/verify.yml and a laptop runs whichever it has, so a failure that only the pinned
// Bun shows surfaced after review. verify and gate run this first: it warns, with the command to run on the pinned
// Bun, and never refuses.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function pinnedBunVersion(workflowText: string): string | undefined {
  return workflowText.match(/^\s*bun-version:\s*['"]?([^\s'"#]+)/m)?.[1];
}

export function bunVersionWarning(pinned: string | undefined, running: string): string | undefined {
  if (pinned === undefined || pinned === running) return undefined;
  return `bun-version: this is Bun ${running}, and CI's verify pins Bun ${pinned} (.github/workflows/verify.yml). Run the check on CI's Bun: SAIL_FULL_SUITE=1 bunx bun@${pinned} run verify`;
}

export function checkBunVersion(workflowPath: string, running: string): string | undefined {
  if (!existsSync(workflowPath)) return undefined;
  return bunVersionWarning(pinnedBunVersion(readFileSync(workflowPath, 'utf8')), running);
}

if (import.meta.main) {
  const warning = checkBunVersion(join(import.meta.dir, '..', '.github', 'workflows', 'verify.yml'), Bun.version);
  if (warning) console.error(warning);
}
