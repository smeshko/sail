// Drives one interleaving of the branch leases deterministically: node:fs is patched so that, the moment run A has read
// the lease file, run B takes the lease. Then A's call finishes. Prints what A and B got, and whom the file names.
//
//   bun test/helpers/lease-race.ts release <dir>   A's run has completed, and A releases while B takes over
//   bun test/helpers/lease-race.ts renew <dir>     A's old pid is dead, and A resumes while B takes over
//
// test/adapters/leases.test.ts spawns it, so the patched module never reaches the test process.
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';

const [mode, dir] = process.argv.slice(2) as ['release' | 'renew', string];
const REMOTE = 'fake://codehost/fixture';
const BRANCH = 'sail/FAKE-1';

let file = '';
let afterRead: (() => void) | undefined;
// Taken before the patch, which replaces the namespace's binding in place.
const original = fs.readFileSync;
const readFileSync = (...args: Parameters<typeof fs.readFileSync>) => {
  const text = original(...args);
  const then = afterRead;
  if (then !== undefined && args[0] === file) {
    afterRead = undefined;
    then();
  }
  return text;
};
mock.module('node:fs', () => ({ ...fs, readFileSync, default: { ...fs, readFileSync } }));

const { leaseFile, readLease, releaseLease, takeLease } = await import('../../src/adapters/leases');
const { writeStatus } = await import('../../src/engine/run-dir');

function runDir(runId: string, status: 'running' | 'completed'): string {
  const path = join(dir, 'runs', runId);
  fs.mkdirSync(path, { recursive: true });
  writeStatus(path, status);
  return path;
}

/** What a result says, with the runs it names by id. */
function bare(result: {
  leased?: boolean;
  released?: boolean;
  took?: string | undefined;
  holder?: { runId: string } | undefined;
}) {
  const { leased, released, took, holder } = result;
  return { leased, released, took, holder: holder?.runId };
}

file = leaseFile(dir, REMOTE, BRANCH);
const dead = Bun.spawn(['true']);
await dead.exited;
const aDir = runDir('A', mode === 'release' ? 'completed' : 'running');
takeLease(dir, REMOTE, BRANCH, { runId: 'A', runDir: aDir, pid: mode === 'release' ? process.pid : dead.pid });

let b: ReturnType<typeof bare> | undefined;
afterRead = () => {
  b = bare(takeLease(dir, REMOTE, BRANCH, { runId: 'B', runDir: runDir('B', 'running'), pid: process.pid }));
};
const a =
  mode === 'release'
    ? bare(releaseLease(dir, REMOTE, BRANCH, 'A'))
    : bare(takeLease(dir, REMOTE, BRANCH, { runId: 'A', runDir: aDir, pid: process.pid }));
console.log(JSON.stringify({ a, b, file: readLease(dir, REMOTE, BRANCH)?.runId ?? null }));
