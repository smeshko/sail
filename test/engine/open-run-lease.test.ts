// openRun and the branch lease (TASK-006): the lease is taken on the remote key and `sail/<ticket key>` after the ticket is
// resolved and before it is claimed, released when the claim is refused, and never overridden by --force. The
// workspace's lease operations are recorded in place, so these cases never touch a lease directory on disk.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openRun } from '../../src/engine/open-run';
import type { TicketSource } from '../../src/ports/ticket-source';
import type { Lease, LeaseResult } from '../../src/ports/types';
import { fakeAdapters } from '../helpers/adapters';
import { writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const NOW = new Date('2026-09-27T09:00:00.000Z');

/** A run that already leases the branch: its lease, as the workspace reports it. */
const HELD: Lease = {
  runId: 'FAKE-1-01HELDBYANOTHERRUN000000',
  runDir: '/somewhere/else/FAKE-1-01HELDBYANOTHERRUN000000',
  pid: 4242,
  remote: 'remote-x',
  branch: 'sail/FAKE-1',
  takenAt: NOW.toISOString(),
};

type Call =
  | { op: 'remoteKey' }
  | { op: 'lease'; remote: string; branch: string; runId: string }
  | { op: 'claim'; ticketKey: string }
  | { op: 'releaseLease'; remote: string; branch: string; runId: string };

/**
 * The repository's adapters, with the workspace's lease operations and the ticket's claim recorded in `calls`. Each lease
 * answers as `held` says: taken when left out, refused by `held` otherwise. A claim is refused, as it would be for a
 * ticket that is already claimed.
 */
async function recording(repoDir: string, calls: Call[], held?: Lease) {
  const adapters = await fakeAdapters(repoDir);
  Object.assign(adapters.ports.workspace, {
    remoteKey: async () => {
      calls.push({ op: 'remoteKey' });
      return 'remote-x';
    },
    lease: async (remote: string, branch: string, holder: { runId: string; runDir: string; pid: number }) => {
      calls.push({ op: 'lease', remote, branch, runId: holder.runId });
      const answer: LeaseResult =
        held === undefined
          ? { leased: true, lease: { ...holder, remote, branch, takenAt: NOW.toISOString() }, raw: null }
          : { leased: false, holder: held, raw: null };
      return answer;
    },
    releaseLease: async (remote: string, branch: string, runId: string) => {
      calls.push({ op: 'releaseLease', remote, branch, runId });
      return { released: true, raw: null };
    },
  });
  const { ticketSource } = adapters.ports;
  ticketSource.claim = (async (ticketKey: string) => {
    calls.push({ op: 'claim', ticketKey });
    return { claimed: false, state: { type: 'unstarted', name: 'Todo' }, raw: null };
  }) as TicketSource['claim'];
  return adapters;
}

/** The runs in `repoDir`'s `.sail-runs/`, or none: the fake adapters keep their own state under `fake/`. */
const runIds = (repoDir: string): string[] =>
  existsSync(join(repoDir, '.sail-runs'))
    ? readdirSync(join(repoDir, '.sail-runs')).filter((name) => name !== 'fake')
    : [];

// STICKER: the lease taken before the claim is TASK-006's. Each sticker names that task.

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a run takes the lease on its remote key and sail/FAKE-1 before it claims the ticket, and releases it when the claim is refused', async () => {
    await withTempRepo(async (repo) => {
      writeStub(repo.dir);
      const calls: Call[] = [];
      const run = await openRun({
        cwd: repo.dir,
        workflow: 'ticket-to-pr',
        ticket: 'FAKE-1',
        adapters: await recording(repo.dir, calls),
        clock: () => NOW,
      });
      expect('refused' in run).toBe(true);
      expect(calls.map((call) => call.op)).toEqual(['remoteKey', 'lease', 'claim', 'releaseLease']);
      const leased = calls[1];
      expect(calls.slice(1)).toEqual([
        { op: 'lease', remote: 'remote-x', branch: 'sail/FAKE-1', runId: leased?.op === 'lease' ? leased.runId : '' },
        { op: 'claim', ticketKey: 'FAKE-1' },
        { op: 'releaseLease', remote: 'remote-x', branch: 'sail/FAKE-1', runId: leased?.op === 'lease' ? leased.runId : '' },
      ]);
    });
  });

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a branch another run leases refuses the start before the claim, naming that run, with no run directory, and --force does not lift it', async () => {
    await withTempRepo(async (repo) => {
      writeStub(repo.dir);
      const calls: Call[] = [];
      const refused = await openRun({
        cwd: repo.dir,
        workflow: 'ticket-to-pr',
        ticket: 'FAKE-1',
        adapters: await recording(repo.dir, calls, HELD),
        clock: () => NOW,
      });
      await withTempRepo(async (forced) => {
        writeStub(forced.dir);
        const forcedCalls: Call[] = [];
        const again = await openRun({
          cwd: forced.dir,
          workflow: 'ticket-to-pr',
          ticket: 'FAKE-1',
          force: true,
          adapters: await recording(forced.dir, forcedCalls, HELD),
          clock: () => NOW,
        });
        expect({
          refusedNamesHolder: 'refused' in again && again.refused.includes(HELD.runId),
          claimed: forcedCalls.some((call) => call.op === 'claim'),
          runs: runIds(forced.dir),
        }).toEqual({ refusedNamesHolder: true, claimed: false, runs: [] });
      });
      expect({
        refusedNamesHolder: 'refused' in refused && refused.refused.includes(HELD.runId),
        claimed: calls.some((call) => call.op === 'claim'),
        runs: runIds(repo.dir),
      }).toEqual({ refusedNamesHolder: true, claimed: false, runs: [] });
    });
  });
