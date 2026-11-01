// `sail clean <run>... | --failed`: removes each failed run's worktree, branches and run ref, and archives its run
// directory under the sail home's `failed-runs/` (the engine's `cleanRun()`). The runs are named by their exact ids, or
// are every failed run of the repository with --failed. It resolves only the Workspace port, and the code host only when
// a run's branch is on the remote, so a clean needs no credentials otherwise.
//
// Exit 3 when any run was refused, else 1 when any removal failed, else 0. Each run is cleaned in turn, whatever the
// ones before it came to.
import { homedir } from 'node:os';
import { BUILTINS } from '../../adapters/index';
import { resolveAdapters } from '../../engine/adapters';
import { cleanedMessage, cleanRun } from '../../engine/clean';
import { runsDir } from '../../engine/run-dir';
import { listRuns } from '../../engine/runs';
import { formatIssue } from '../../engine/schemas';
import type { CodeHost } from '../../ports/code-host';
import { queueItemsNaming } from '../../watch/queue-store';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED, type ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';
import { findProject, refuseAs } from './run-workflow';

const COMMAND = 'sail clean';

export async function clean(args: Parsed, io: Io): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  const failedOnly = args.values.failed === true;
  if (failedOnly === args.positionals.length > 0) return refuse('usage: sail clean <run>... | --failed');
  const project = await findProject(io, COMMAND, { ports: ['workspace'] });
  if (typeof project === 'number') return project;
  const env = io.env ?? process.env;

  const runIds = failedOnly
    ? listRuns(project.sailDir)
        .filter((listed) => listed.status?.status === 'failed')
        .map((listed) => listed.runId)
    : [...new Set(args.positionals)];
  if (runIds.length === 0) {
    io.stderr(`${COMMAND}: no failed runs\n`);
    return EXIT_OK;
  }

  let host: Promise<CodeHost | { refused: string }> | undefined;
  const codeHost = (): Promise<CodeHost | { refused: string }> => {
    host ??= (async () => {
      const resolved = await resolveAdapters({
        sailDir: project.sailDir,
        config: project.config,
        builtins: BUILTINS,
        env,
        ports: ['codeHost'],
      });
      if ('issues' in resolved) return { refused: resolved.issues.map((issue) => formatIssue(issue)).join('; ') };
      return resolved.ports.codeHost;
    })();
    return host;
  };

  const home = env.HOME ?? homedir();
  let code: ExitCode = EXIT_OK;
  for (const runId of runIds) {
    const cleaned = await cleanRun({
      sailDir: project.sailDir,
      runId,
      workspace: project.adapters.ports.workspace,
      queueItems: (id) => queueItemsNaming(runsDir(project.sailDir), id),
      codeHost,
      env,
    });
    if ('refused' in cleaned) {
      refuse(cleaned.refused);
      code = EXIT_REFUSED;
    } else if ('cleaned' in cleaned) {
      io.stdout(`${cleanedMessage(runId, cleaned.cleaned, home)}\n`);
    } else {
      for (const failure of cleaned.failed.failures) io.stderr(`${COMMAND}: ${runId}: ${failure}\n`);
      io.stderr(`${COMMAND}: ${runId}: its run directory stays at .sail-runs/${runId}; clean it again\n`);
      if (code !== EXIT_REFUSED) code = EXIT_FAILED;
    }
  }
  return code;
}
