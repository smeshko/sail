// What the dashboard's start of a run is made of, apart from its server: the body of a check or a start, the arguments
// it gives `sail`, what a refusal offers to override, and the workflows a repository can start. The server runs the CLI
// itself, so the rules of a start are the CLI's own: nothing here decides whether a source may start.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { findWorkflowFile } from '../engine/load-workflow';

/** A workflow's or a stage's name as typed: letters, digits, dots, dashes and underscores, never starting as an option. */
const isName = (name: string): boolean => /^[A-Za-z0-9][\w.-]*$/.test(name) && !name.includes('..');

/** A check or a start: what `sail <source> --workflow <name> --until <stage> [--force] [--ignore-prerequisites]` takes. */
export const StartBody = z.strictObject({
  source: z.string().min(1).max(200),
  workflow: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  force: z.boolean().optional(),
  ignorePrerequisites: z.boolean().optional(),
});

export type StartBody = z.infer<typeof StartBody>;

/** The arguments of `sail <source>` after the source, or why the body can't be one: nothing typed may read as an option. */
export function startArgs(body: StartBody): string[] | { invalid: string } {
  if (body.source.startsWith('-')) return { invalid: `'${body.source}' is no ticket key or pull request` };
  if (body.workflow !== undefined && !isName(body.workflow)) {
    return { invalid: `'${body.workflow}' is no workflow name` };
  }
  if (body.until !== undefined && !isName(body.until)) return { invalid: `'${body.until}' is no stage name` };
  return [
    ...(body.workflow === undefined ? [] : ['--workflow', body.workflow]),
    ...(body.until === undefined ? [] : ['--until', body.until]),
    ...(body.force === true ? ['--force'] : []),
    ...(body.ignorePrerequisites === true ? ['--ignore-prerequisites'] : []),
  ];
}

/**
 * The flag that would let a refused start through, from the CLI's exit code and what it printed: a prerequisite that
 * waits is exit 5, a check `--force` overrides says so in its last words, and any other refusal offers none.
 */
export function overrideOf(exit: number | null, text: string): 'force' | 'ignore-prerequisites' | undefined {
  if (exit === 5) return 'ignore-prerequisites';
  if (exit === 3 && /--force (runs|starts) it/.test(text)) return 'force';
  return undefined;
}

/** The key the run of `source` is named by: `pr-<number>` for a pull request, else the ticket key. */
export const runKeyOf = (source: string): string => (source.startsWith('#') ? `pr-${source.slice(1)}` : source);

/** The checks the roster's `forced` line says `--force` overrode. */
export function forcedOf(roster: string): string[] {
  const line = /^ {2}forced {4}(.+)$/m.exec(roster)?.[1];
  return line === undefined ? [] : line.split(', ');
}

/** The workflows of `<sailDir>/workflows/` that hold a `workflow.ts`, sorted. */
export function startableWorkflows(sailDir: string): string[] {
  const dir = join(sailDir, 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => 'file' in findWorkflowFile(sailDir, name))
    .sort();
}
