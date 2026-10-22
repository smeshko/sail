// `sail stop <run>`: stops a run of the repository sail is run from, with stop reason `stopped`, with or without a
// watcher (DECISIONS D7). The run is named by its exact id, as `sail resume` takes it, since a stop can't be undone.
//
// - A run that is running, alive in another process, gets a stop request in its control file, and the command exits 0
//   at once, saying it stops at its next call boundary: a run may be inside a long agent call, and `sail show <run>
//   --follow` follows it to its end.
// - A run that nothing runs, suspended or running with its process gone, ends `failed stopped` now: its workspace and
//   lease are released, and `run:end` closes its stream.
// - A run that has ended, and a run id that names no run, are refused with exit 3.
//
// It resolves only the Workspace port, so no ticket source is asked for its credentials, and loads no workflow.
import { stopRun } from '../../engine/stop';
import { EXIT_OK, type ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';
import { findProject, refuseAs } from './run-workflow';

const COMMAND = 'sail stop';

export async function stop(args: Parsed, io: Io): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  const [runId] = args.positionals;
  if (runId === undefined) return refuse('usage: sail stop <run>');
  const project = await findProject(io, COMMAND, { ports: ['workspace'] });
  if (typeof project === 'number') return project;
  const stopped = await stopRun({ sailDir: project.sailDir, runId, adapters: project.adapters });
  if ('refused' in stopped) return refuse(stopped.refused);
  if ('requested' in stopped) {
    io.stdout(`${COMMAND}: run ${runId} stops at its next call boundary (pid ${stopped.requested.pid})\n`);
  } else {
    io.stdout(`${COMMAND}: run ${runId} stopped\n`);
  }
  return EXIT_OK;
}
