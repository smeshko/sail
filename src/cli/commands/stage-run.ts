// `sail stage run <stage-dir> [--bind name=value]...`: runs one stage in isolation, with its whole contract enforced,
// into `.sail-runs/<stage>-<ulid>/00-<stage>/call-1/` beside its `.sail/`. Every refusal comes before anything is
// written. This module parses, prints and maps the outcome to an exit code; the work is the engine's.
//
// An agent stage runs on the harness `project.yaml` names, with the model its alias names there, and each agent step of
// a multi-step stage on its own. Only the harness is resolved: a stage in isolation reaches no ticket source, code host
// or workspace, so it needs none of their credentials. A script stage resolves no adapter at all. A multi-step stage
// runs its steps in order, with no journal and no resume, and a step that declares a `gitDiff()` can't start: a stage
// in isolation has no workspace to take one from.
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { BUILTINS } from '../../adapters/index';
import { resolveAdapters } from '../../engine/adapters';
import type { Supplied } from '../../engine/bindings';
import { type AgentExecution, callProblems, runCall } from '../../engine/call';
import { type ProjectConfig, readConfig } from '../../engine/config';
import { loadStageFile, stageFileProblem, stageFolder } from '../../engine/definitions';
import { modelProblemsOf } from '../../engine/roster';
import { runsDir } from '../../engine/run-dir';
import { newRunId } from '../../engine/run-id';
import { findSailDir } from '../../engine/sail-dir';
import { formatIssue, type SchemaIssue } from '../../engine/schemas';
import { stepProblems } from '../../engine/stage-call';
import { typecheck } from '../../engine/typecheck';
import type { AgentStep, StageDefinition, Step } from '../../sdk/steps';
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
  // A Map, not assignment: `supplied['__proto__'] = …` would set the prototype, and the binding would go unchecked.
  const supplied = new Map<string, Supplied>();
  for (const bind of binds) {
    const equals = bind.indexOf('=');
    if (equals < 0) return { refused: `--bind '${bind}' has no '=': use --bind name=value` };
    const name = bind.slice(0, equals);
    const text = bind.slice(equals + 1);
    if (supplied.has(name)) return { refused: `'${name}' is bound twice` };
    const binding = Object.hasOwn(definition.consumes, name) ? definition.consumes[name] : undefined;
    if (binding?.kind === 'file') {
      const path = resolve(cwd, text);
      supplied.set(name, { kind: 'file', path, from: relative(workspace, path) });
    } else if (binding?.kind === 'value') {
      try {
        supplied.set(name, { kind: 'value', value: JSON.parse(text), from: '--bind' });
      } catch (error) {
        return { refused: `'${name}': not JSON: ${(error as Error).message}` };
      }
    } else {
      supplied.set(name, { kind: 'value', value: text, from: '--bind' });
    }
  }
  return { supplied: Object.fromEntries(supplied) };
}

/**
 * What a stage with an agent step, run in isolation, runs on, resolved before anything is written: the model each agent
 * step's alias names in `project.yaml`, then the harness alone. An alias `models` doesn't define refuses, and so does
 * a harness with issues.
 */
async function executionOf(
  definition: StageDefinition,
  sailDir: string,
  config: ProjectConfig,
  env: Io['env'],
): Promise<AgentExecution | { refused: string } | { issues: SchemaIssue[] }> {
  const undefinedAlias = modelProblemsOf(`stage '${definition.name}'`, definition, config);
  if (undefinedAlias.length > 0) return { refused: undefinedAlias.join('\n') };
  const steps: readonly Step[] = definition.kind === 'stage' ? definition.steps : [definition];
  const agents = steps.filter((step): step is AgentStep => step.kind === 'agent');
  const models = Object.fromEntries(
    agents.map((step) => [step.name, config.models[step.model ?? 'default'] as string]),
  );
  const adapters = await resolveAdapters({
    sailDir,
    config,
    builtins: BUILTINS,
    env: env ?? process.env,
    ports: ['harness'],
  });
  if ('issues' in adapters) return adapters;
  const { conventions } = config;
  return {
    harness: adapters.ports.harness,
    model: Object.values(models)[0] as string,
    ...(definition.kind === 'stage' && definition.steps.length > 1 ? { models } : {}),
    ...(conventions === undefined ? {} : { conventions }),
  };
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
  if (stageFolder(found.dir, stageDir) === undefined) {
    const locations = '.sail/stages/<stage>/ or .sail/workflows/<workflow>/stages/<stage>/';
    return refuse(`${at(stageDir)} is not a stage folder: stages live in ${locations}`);
  }
  const workspace = dirname(found.dir);

  /** Refuses with each issue of `project.yaml`, as `sail <ticket>` prints them. */
  const refuseConfig = (issues: readonly SchemaIssue[]): ExitCode => {
    const file = at(join(found.dir, 'project.yaml'));
    for (const issue of issues) io.stderr(`${formatIssue({ ...issue, file })}\n`);
    return EXIT_REFUSED;
  };
  const config = readConfig(found.dir);
  if ('issues' in config) return refuseConfig(config.issues);

  // What runs is type-checked: the stage's own files, so a half-edited workflow elsewhere doesn't block it.
  const types = await typecheck(found.dir, {
    files: [stageFile],
    ...(io.tsc === undefined ? {} : { tsc: io.tsc }),
  });
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
  // The same rules as `sail check`: one definition, named after its folder.
  const problem = stageFileProblem(stageFile, loaded.definitions);
  const [definition] = loaded.definitions;
  if (problem !== undefined || definition === undefined) return refuse(`${at(stageFile)}: ${problem}`);
  // The same wiring rules as loading: a stage whose steps are wired wrongly never runs.
  const wiring = definition.kind === 'stage' ? stepProblems(definition) : [];
  if (wiring.length > 0) return refuse(`${at(stageFile)}: ${wiring.join(`\n  `)}`);

  const runsAgent = (definition.kind === 'stage' ? definition.steps : [definition]).some(
    (step) => step.kind === 'agent',
  );
  const agent = runsAgent ? await executionOf(definition, found.dir, config, io.env) : undefined;
  if (agent !== undefined && 'refused' in agent) return refuse(agent.refused);
  if (agent !== undefined && 'issues' in agent) return refuseConfig(agent.issues);

  const binds = args.values.bind;
  const given = supply(Array.isArray(binds) ? binds : [], definition, io.cwd, workspace);
  if ('refused' in given) return refuse(given.refused);
  const problems = callProblems(definition, given.supplied, agent);
  if (problems.length > 0) {
    return refuse(`${definition.name} can't run:\n${problems.map((problem) => `  ${hanging(problem, 2)}`).join('\n')}`);
  }

  const runId = newRunId(definition.name);
  const controller = new AbortController();
  const unregister = io.onInterrupt?.(() => controller.abort());
  let ran: Awaited<ReturnType<typeof runCall>>;
  try {
    ran = await runCall({
      runDir: join(runsDir(found.dir), runId),
      runId,
      stageIndex: 0,
      call: 1,
      definition,
      stageFile,
      // In the directory that holds `.sail/`, and on no branch: a stage in isolation belongs to no run, so it has no
      // workspace or branch of its own.
      workspace,
      root: workspace,
      branch: '',
      config: join(found.dir, 'project.yaml'),
      supplied: given.supplied,
      signal: controller.signal,
      ...(agent === undefined ? {} : { agent }),
    });
  } finally {
    unregister?.();
  }

  const { result, paths } = ran;
  io.stdout(`${result.key} ${result.outcome}  ${at(paths.dir)}\n`);
  const errors = (result.errors ?? []) as { reason: string; message: string }[];
  for (const { reason, message } of errors) io.stdout(`  ${reason}  ${hanging(message, reason.length + 4)}\n`);
  // A blocked agent kept its contract and says why it stopped: its reason is all there is to print.
  if (result.outcome === 'blocked') io.stdout(`  ${hanging(String(result.reason), 2)}\n`);
  return result.outcome === 'passed' || result.outcome === 'done' ? EXIT_OK : EXIT_FAILED;
}
