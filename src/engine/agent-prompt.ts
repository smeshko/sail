// prepareAgentPrompt(): an agent step's prompt as its harness receives it. The step's `prompt.md` and the shared fragments
// are rendered with the call's bindings, then the repository's convention files and a corrective try's feedback are
// appended as they are: neither is read as a template.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { inputVar, type PreparedBindings } from './bindings';
import { type FragmentName, renderPrompt } from './prompt';
import type { RenderValues } from './render';
import { markUntrusted } from './untrusted';

/** The convention files appended when `project.yaml` names none, in order. One that doesn't exist is skipped. */
export const DEFAULT_CONVENTIONS = ['AGENTS.md', 'CLAUDE.md'] as const;

export interface AgentPromptOptions {
  /** The repository's `.sail/`. The workspace is the directory that holds it. */
  sailDir: string;
  /** The prompt's absolute path. */
  file: string;
  bindings: PreparedBindings;
  /** The `INPUT_<NAME>` variables: where this try's `$STAGE_IN` holds each binding. */
  inputs: Readonly<Record<string, string>>;
  /** `project.yaml`'s `conventions`, each relative to the workspace. Left out, the defaults are appended. */
  conventions?: readonly string[];
  /** The messages of the validation failure this try corrects, appended last. */
  feedback?: readonly string[];
}

export type AgentPrompt =
  | {
      ok: true;
      text: string;
      /** The untrusted values the prompt prints. */
      untrusted: number;
      fragments: { name: FragmentName; origin: string }[];
      /** The convention files appended, each relative to the workspace, in order. */
      conventions: string[];
    }
  /** Why there is no prompt: a file that can't be read, a template that can't be rendered. */
  | { ok: false; message: string };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The prompt's values, by binding name: a value as its schema parsed it, with the strings the schema marks untrusted
 * marked so; a file as where `$STAGE_IN` holds its copy; and null for a binding left unbound, so `#if` can read it.
 */
function valuesOf(bindings: PreparedBindings, inputs: Readonly<Record<string, string>>): RenderValues {
  const values: [string, unknown][] = [];
  for (const [key, binding] of Object.entries(bindings.consumes)) {
    if (binding.kind === 'value' && Object.hasOwn(bindings.values, key)) {
      values.push([key, markUntrusted(binding.schema, bindings.values[key], key)]);
    } else {
      values.push([key, binding.kind === 'file' ? (inputs[inputVar(key)] ?? null) : null]);
    }
  }
  return Object.fromEntries(values);
}

/** Whether `path` is `root` or below it. */
function isWithin(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

/**
 * Reads the convention files: the listed ones, each of which must be a regular file inside the workspace, or the
 * defaults that exist when none is listed. A file two names lead to, as a `CLAUDE.md` linked to `AGENTS.md` does, is
 * read once, under the first.
 */
function readConventions(
  workspace: string,
  listed: readonly string[] | undefined,
): { files: { path: string; text: string }[] } | { message: string } {
  const files: { path: string; text: string }[] = [];
  /** The real path of each file read. */
  const read = new Set<string>();
  for (const name of listed ?? DEFAULT_CONVENTIONS) {
    const refused = (why: string) => ({ message: `convention ${name} ${why}` });
    if (isAbsolute(name)) return refused('is absolute: a convention is a path inside the repository');
    const path = resolve(workspace, name);
    try {
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile()) {
        if (listed === undefined) continue;
        return refused(stat === undefined ? "doesn't exist" : 'is not a regular file');
      }
      // A symlink on the way can lead out of the repository, which the path alone doesn't show.
      const real = realpathSync(path);
      if (!isWithin(realpathSync(workspace), real)) return refused('is outside the repository');
      if (read.has(real)) continue;
      read.add(real);
      files.push({ path: name, text: readFileSync(real, 'utf8') });
    } catch (error) {
      return refused(`can't be read: ${messageOf(error)}`);
    }
  }
  return { files };
}

export function prepareAgentPrompt(options: AgentPromptOptions): AgentPrompt {
  const { sailDir, file, bindings, inputs, feedback = [] } = options;
  const conventions = readConventions(dirname(sailDir), options.conventions);
  if ('message' in conventions) return { ok: false, message: conventions.message };
  let rendered: ReturnType<typeof renderPrompt>;
  try {
    rendered = renderPrompt({ sailDir, file, values: valuesOf(bindings, inputs) });
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
  const parts = [rendered.text.trimEnd()];
  for (const { path, text } of conventions.files) {
    parts.push(`## Repository conventions: ${path}\n\n${text.trimEnd()}`);
  }
  if (feedback.length > 0) {
    const intro = 'Your last output was rejected. Fix each problem below, then submit again.';
    parts.push(`## Fix your last output\n\n${intro}\n\n${feedback.map((message) => message.trimEnd()).join('\n\n')}`);
  }
  return {
    ok: true,
    text: `${parts.join('\n\n')}\n`,
    untrusted: rendered.untrusted,
    fragments: rendered.fragments,
    conventions: conventions.files.map(({ path }) => path),
  };
}
