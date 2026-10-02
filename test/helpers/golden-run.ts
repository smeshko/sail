// Copies of the golden run in a test's temp repository: `.sail-runs/<run id>/`, as `sail runs` and `sail show` read it.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const GOLDEN_RUN_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
export const GOLDEN_RUN = join(import.meta.dir, '..', 'fixtures', 'runs', GOLDEN_RUN_ID);

export interface CopyOptions {
  /** The copy's directory name and run.json's `runId`. The golden run's by default. */
  runId?: string;
  /** run.json's `startedAt`. The golden run's by default. */
  startedAt?: string;
  /** STATUS, as written. The golden run's `completed` by default. */
  status?: string;
}

/** Makes `<repoDir>/.sail/`, empty: `sail runs` and `sail show` find it, and never read `project.yaml`. */
export function emptySailDir(repoDir: string): string {
  const sail = join(repoDir, '.sail');
  mkdirSync(sail, { recursive: true });
  return sail;
}

/** Copies the golden run into `<repoDir>/.sail-runs/`, changed as `options` say, and returns the copy. */
export function copyGoldenRun(repoDir: string, options: CopyOptions = {}): string {
  const runId = options.runId ?? GOLDEN_RUN_ID;
  const dir = join(repoDir, '.sail-runs', runId);
  cpSync(GOLDEN_RUN, dir, { recursive: true });
  const header = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  const startedAt = options.startedAt ?? header.startedAt;
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify({ ...header, runId, startedAt }, null, 2)}\n`);
  if (options.status !== undefined) writeFileSync(join(dir, 'STATUS'), options.status);
  return dir;
}
