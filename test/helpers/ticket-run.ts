// A run from a ticket in a process of its own: `bun test/helpers/ticket-run.ts <ticket key> [-q|-v|-vv]`, from the
// repository the run starts in. No command starts a run from a ticket until `sail <ticket>` exists, so this is how a
// test starts one in a process it can signal. It takes `sail run`'s steps with a source in place of `--input`: the
// adapters are resolved from `project.yaml`, the terminal view prints the run's events, Ctrl-C or SIGTERM suspends
// the run, and the exit code is the run's status.
//
// A script, never imported: it runs on import.

import { findProject, interruptibly, printEnd, terminalFor } from '../../src/cli/commands/run-workflow';
import { EXIT_REFUSED } from '../../src/cli/exit-codes';
import type { Io } from '../../src/cli/index';
import { runWorkflow } from '../../src/engine/runtime';
import type { Verbosity } from '../../src/events/consumers/terminal';

const COMMAND = 'ticket-run';
const VERBOSITY: Record<string, Verbosity> = { '-q': 'quiet', '-v': 'verbose', '-vv': 'trace' };

const [ticketKey = '', flag = ''] = process.argv.slice(2);
const io: Io = {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  onInterrupt: (handler) => {
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
    return () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    };
  },
  env: process.env,
};

const project = await findProject(io, COMMAND);
if (typeof project === 'number') process.exit(project);
const terminal = terminalFor(io, project.sailDir, VERBOSITY[flag] ?? 'normal');
const end = await interruptibly(io, (signal) =>
  runWorkflow({
    cwd: io.cwd,
    workflow: 'ticket-to-pr',
    source: { kind: 'ticket', ticketKey, via: 'cli', forced: false },
    adapters: project.adapters,
    signal,
    consumers: [terminal],
  }).finally(() => terminal.close()),
);
if ('refused' in end) {
  io.stderr(`${COMMAND}: ${end.refused}\n`);
  process.exitCode = EXIT_REFUSED;
} else process.exitCode = printEnd(end, io, undefined);
