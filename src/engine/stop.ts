// `stopRun()`: the engine side of `sail stop <run>` (DECISIONS D7). It tells a live run from one nothing runs by taking
// the run's lease, as a resume renews it:
// - **Refused, held by this run in another live process:** the run is running. It gets a stop request in its control
//   file, and ends `failed stopped` at its next call boundary (ending its running call with --now).
// - **Taken:** nothing runs the run, whether it is suspended or running with its process gone. Its STATUS is read again,
//   since a run that ended in between is refused, and the lease given back. Then, in order: the events file's torn tail
//   is cut, STATUS becomes `failed stopped`, the workspace and the lease are released, and `run:end` goes out through a
//   bus with the events file and the summary, so `summary.json` is final. A release that fails as a port fails is said
//   in `run:end`'s message, as `finish()` in runtime.ts says it.
// - **Refused, held by another run:** this run's lease went stale and was taken over. It ends as above, with no lease
//   to release.
// A run from before workspaces has no lease or workspace, and ends as above with nothing to release.
//
// It needs only the Workspace port, and loads no workflow: a workflow changed since the run started can't block a stop.
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createBus } from '../events/bus';
import { ndjsonConsumer, nextSeq } from '../events/consumers/ndjson';
import { summaryConsumer } from '../events/consumers/summary';
import type { NewEvent, ProviderEvent } from '../events/types';
import { PortError } from '../ports/errors';
import type { ResolvedAdapters } from './adapters';
import { isPlainName } from './call-dir';
import { type Clock, systemClock } from './clock';
import { requestStop, requestStopNow } from './control';
import { rootRelative } from './open-run';
import { credentialValues, redactor } from './redact';
import { type RunStatus, readStatus, runsDir, writeStatus } from './run-dir';
import { RUN_HEADER_FILE, readRunHeader } from './run-header';
import type { RunEnd } from './runtime';

export interface StopRunOptions {
  now?: boolean;
  /** The `.sail/` the run belongs to: the run is found beside it. */
  sailDir: string;
  runId: string;
  /** The Workspace port, which holds the run's lease and workspace. */
  adapters: ResolvedAdapters<'workspace'>;
  /** The credentials masked in the events written. The environment's by default. */
  secrets?: readonly string[];
  /** What `run:end` is stamped with. The system's by default. */
  clock?: Clock;
}

/** How a stop went: the run ended now, a running run was asked to stop, or the stop was refused. */
export type Stopped = { ended: RunEnd } | { requested: { pid: number; now?: boolean } } | { refused: string };

const MESSAGE = 'stopped by sail stop';

/** The run's STATUS, or undefined while it has none. */
function statusOf(dir: string): RunStatus | undefined {
  return existsSync(join(dir, 'STATUS')) ? readStatus(dir) : undefined;
}

/** Why the run in `dir` can't be stopped because it has ended, or undefined while it hasn't. */
function hasEnded(dir: string, runId: string): string | undefined {
  const status = statusOf(dir);
  if (status?.status !== 'completed' && status?.status !== 'failed') return undefined;
  const how = status.stopReason === undefined ? status.status : `${status.status} ${status.stopReason}`;
  return `run ${runId} has ended (${how}): there is nothing to stop`;
}

export async function stopRun(options: StopRunOptions): Promise<Stopped> {
  const { sailDir, runId } = options;
  const runs = runsDir(sailDir);
  const root = dirname(sailDir);
  if (!isPlainName(runId)) return { refused: `'${runId}' is not a run id` };
  const dir = join(runs, runId);
  if (!existsSync(join(dir, RUN_HEADER_FILE))) return { refused: `no run '${runId}' in ${relative(root, runs)}` };
  const ended = hasEnded(dir, runId);
  if (ended !== undefined) return { refused: ended };

  const { branch, repository } = readRunHeader(dir);
  const port = options.adapters.ports.workspace;
  const run = { runId, runDir: dir };
  const collected: ProviderEvent[] = [];
  const detach = options.adapters.relay.attach((event) => {
    if (event.type.startsWith('workspace:')) collected.push(rootRelative(event, root));
  });
  try {
    /** The lease this stop holds, to release once the run has ended. */
    let lease: { remote: string; branch: string } | undefined;
    if (branch !== undefined && repository !== undefined) {
      let leased: Awaited<ReturnType<typeof port.lease>>;
      try {
        leased = await port.lease(repository.url, branch, { runId, runDir: dir, pid: process.pid });
      } catch (error) {
        if (!(error instanceof PortError)) throw error;
        return { refused: `the branch ${branch} could not be leased: ${error.message} (${error.code})` };
      }
      if (!leased.leased && leased.holder.runId === runId) {
        if (options.now) requestStopNow(dir);
        else requestStop(dir);
        return { requested: { pid: leased.holder.pid, ...(options.now ? { now: true } : {}) } };
      }
      if (leased.leased) {
        lease = { remote: repository.url, branch };
        const meanwhile = hasEnded(dir, runId);
        if (meanwhile !== undefined) {
          await port.releaseLease(repository.url, branch, runId);
          return { refused: meanwhile };
        }
      }
    }

    const firstSeq = nextSeq(dir);
    if (typeof firstSeq !== 'number') return firstSeq;
    writeStatus(dir, 'failed', 'stopped');
    const said: string[] = [MESSAGE];
    if (repository !== undefined) {
      try {
        await port.release(run, false);
      } catch (error) {
        if (!(error instanceof PortError)) throw error;
        said.push(`its workspace was not released: ${error.message}`);
      }
    }
    if (lease !== undefined) {
      try {
        await port.releaseLease(lease.remote, lease.branch, runId);
      } catch (error) {
        if (!(error instanceof PortError)) throw error;
        said.push(`its lease on ${lease.branch} was not released: ${error.message}`);
      }
    }
    const redact = redactor(options.secrets ?? credentialValues(process.env));
    const bus = createBus({
      runId,
      firstSeq,
      now: options.clock ?? systemClock,
      consumers: [ndjsonConsumer(dir), summaryConsumer(dir)],
      mask: redact.value,
    });
    for (const event of collected) bus.emit(event as NewEvent);
    const message = redact.text(said.join('; '));
    bus.emit({ type: 'run:end', status: 'failed', stopReason: 'stopped', message, replays: 0 });
    return { ended: { runId, dir, status: 'failed', stopReason: 'stopped', message } };
  } finally {
    detach();
  }
}
