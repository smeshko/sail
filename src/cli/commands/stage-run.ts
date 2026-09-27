// `sail stage run <stage-dir> [--bind name=value]...`: runs one script stage in isolation, with its whole contract
// enforced, into `.sail-runs/<stage>-<ulid>/00-<stage>/call-1/` beside its `.sail/`. Every refusal comes before anything
// is written. This module parses, prints and maps the outcome to an exit code; the work is the engine's.
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Supplied } from '../../engine/bindings';
import { callProblems, runCall } from '../../engine/call';
import { loadStageFile } from '../../engine/definitions';
import { newRunId } from '../../engine/run-id';
import { findSailDir, projectIssues } from '../../engine/sail-dir';
import { formatIssue } from '../../engine/schemas';
import { typecheck } from '../../engine/typecheck';
import type { StageDefinition } from '../../sdk/steps';
import { EXIT_FAILED, EXIT_INTERNAL, EXIT_OK, EXIT_REFUSED, type ExitCode } from '../exit-codes';
import { count, formatDiagnostic } from '../format';
import type { Io, Parsed } from '../index';

const USAGE = 'usage: sail stage run <stage-dir> [--bind name=value]...';

/** Indents every line of `text` after the first by `width`, so a multi-line message hangs under its first line. */
const hanging = (text: string, width: number) => text.replaceAll('\n', `\n${' '.repeat(width)}`);

/**
 * Turns each `--bind name=value` into a supplied binding. The binding's kind decides how `value` reads: a path for a
 * `file()`, resolved against `cwd`, and JSON for a `value()`. A name the stage can't take is passed on as text, for
 * `callProblems` to name.
 */
function supply(
  binds: readonly string[],
  definition: StageDefinition,
  cwd: string,
  workspace: string,
): { supplied: Record<string, Supplied> } | { refused: string } {
  const supplied: Record<string, Supplied> = {};
  for (const bind of binds) {
    const equals = bind.indexOf('=');
    if (equals < 0) return { refused: `--bind '${bind}' has no '=': use --bind name=value` };
    const name = bind.slice(0, equals);
    const text = bind.slice(equals + 1);
    if (Object.hasOwn(supplied, name)) return { refused: `'${name}' is bound twice` };
    const binding = Object.hasOwn(definition.consumes, name) ? definition.consumes[name] : undefined;
    if (binding?.kind === 'file') {
      const path = resolve(cwd, text);
      supplied[name] = { kind: 'file', path, from: relative(workspace, path) };
    } else if (binding?.kind === 'value') {
      try {
        supplied[name] = { kind: 'value', value: JSON.parse(text), from: '--bind' };
      } catch (error) {
        return { refused: `'${name}': not JSON: ${(error as Error).message}` };
      }
    } else {
      supplied[name] = { kind: 'value', value: text, from: '--bind' };
    }
  }
  return { supplied };
}

export async function stageRun(args: Parsed, io: Io): Promise<ExitCode> {
  /** Every path the command prints goes through here, relative to where the user ran it. */
  const at = (path: string) => relative(io.cwd, path) || '.';
  const refuse = (message: string): ExitCode => {
    io.stderr(`sail stage run: ${message}\n`);
    return EXIT_REFUSED;
  };

  const [subcommand, dir] = args.positionals;
  if (subcommand !== 'run' || dir === undefined) return refuse(USAGE);
  const stageDir = resolve(io.cwd, dir);
  const stageFile = join(stageDir, 'stage.ts');
  if (!existsSync(stageFile)) return refuse(`no stage.ts in ${at(stageDir)}`);

  // Found from the stage directory, not from where the user is, so a stage in another repository runs as its own.
  const found = findSailDir(stageDir);
  if ('refused' in found) return refuse(found.refused);
  const within = relative(found.dir, stageDir);
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    return refuse(`${at(stageDir)} is not inside ${at(found.dir)}/`);
  }
  const workspace = dirname(found.dir);

  const issues = projectIssues(found.dir);
  if (issues.length > 0) {
    const file = at(join(found.dir, 'project.yaml'));
    for (const issue of issues) io.stderr(`${formatIssue({ ...issue, file })}\n`);
    return EXIT_REFUSED;
  }

  // What runs is type-checked: the stage's own files, so a half-edited workflow elsewhere doesn't block it.
  const types = await typecheck(found.dir, { files: [stageFile] });
  if ('internal' in types) {
    io.stderr(`sail stage run: could not run tsc\n${types.internal}\n`);
    return EXIT_INTERNAL;
  }
  if (!types.ok) {
    for (const diagnostic of types.diagnostics) io.stderr(`${formatDiagnostic(diagnostic, at)}\n`);
    const errors = types.diagnostics.filter((diagnostic) => diagnostic.code !== '').length;
    return refuse(`${count(errors, 'type error')} in ${at(stageFile)}`);
  }

  const loaded = await loadStageFile(stageFile);
  if ('problem' in loaded) return refuse(`${at(stageFile)}: ${loaded.problem}`);
  const [definition, ...others] = loaded.definitions;
  if (definition === undefined || others.length > 0) {
    const names = loaded.definitions.map(({ name }) => name).join(', ');
    return refuse(
      `${at(stageFile)} must export one stage definition, and exports ${loaded.definitions.length}` +
        (names === '' ? '' : `: ${names}`),
    );
  }

  const binds = args.values.bind;
  const given = supply(Array.isArray(binds) ? binds : [], definition, io.cwd, workspace);
  if ('refused' in given) return refuse(given.refused);
  const problems = callProblems(definition, given.supplied);
  if (problems.length > 0) {
    return refuse(`${definition.name} can't run:\n${problems.map((problem) => `  ${hanging(problem, 2)}`).join('\n')}`);
  }

  const runId = newRunId(definition.name);
  const controller = new AbortController();
  const unregister = io.onInterrupt?.(() => controller.abort());
  let ran: Awaited<ReturnType<typeof runCall>>;
  try {
    ran = await runCall({
      runDir: join(workspace, '.sail-runs', runId),
      runId,
      stageIndex: 0,
      call: 1,
      definition,
      stageFile,
      workspace,
      config: join(found.dir, 'project.yaml'),
      supplied: given.supplied,
      signal: controller.signal,
    });
  } finally {
    unregister?.();
  }

  const { result, paths } = ran;
  io.stdout(`${result.key} ${result.outcome}  ${at(paths.dir)}\n`);
  const errors = (result.errors ?? []) as { reason: string; message: string }[];
  for (const { reason, message } of errors) io.stdout(`  ${reason}  ${hanging(message, reason.length + 4)}\n`);
  return result.outcome === 'passed' ? EXIT_OK : EXIT_FAILED;
}
