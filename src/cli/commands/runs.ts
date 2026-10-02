// `sail runs`: lists the runs of the repository sail is run from, oldest first, so the newest is nearest the prompt. It
// reads only `.sail-runs/`, never `project.yaml`, so runs stay viewable while the config is broken. A run whose files
// can't be read still gets a row, with `?` where they would go, and its problem goes to stderr.
import { RUNS_DIR } from '../../engine/run-dir';
import { listRuns } from '../../engine/runs';
import { findSailDir } from '../../engine/sail-dir';
import { EXIT_OK, type ExitCode } from '../exit-codes';
import { table } from '../format';
import type { Io, Parsed } from '../index';
import { refuseAs } from './run-workflow';

const COMMAND = 'sail runs';

export function runs(_: Parsed, io: Io): ExitCode {
  const found = findSailDir(io.cwd);
  if ('refused' in found) return refuseAs(io, COMMAND)(found.refused);
  const listed = listRuns(found.dir);
  if (listed.length === 0) {
    io.stdout(`no runs in ${RUNS_DIR}\n`);
    return EXIT_OK;
  }
  const rows = listed.map(({ runId, workflow, startedAt, status, problem }) => {
    if (problem !== undefined) io.stderr(`${COMMAND}: ${runId}: ${problem}\n`);
    return [
      runId,
      workflow ?? '?',
      status === undefined ? '?' : [status.status, status.stopReason].filter(Boolean).join(' '),
      // Whole seconds: `2026-09-25T09:00:00Z`.
      startedAt === undefined ? '?' : `${new Date(startedAt).toISOString().slice(0, 19)}Z`,
    ];
  });
  for (const line of table([['run', 'workflow', 'status', 'started'], ...rows])) io.stdout(`${line}\n`);
  return EXIT_OK;
}
