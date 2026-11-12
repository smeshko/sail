// prepareAgentPrompt(): an agent step's prompt, in the parts its harness receives. The message is the step's
// `prompt.md` and the shared fragments, rendered with the call's bindings, then a corrective try's feedback. The
// repository's convention files are apart from it, so two steps with the same conventions hand their harness the same
// text, which goes in the session's system prompt and is read from the prompt cache. `text` is the record `prompt.md`
// keeps: the conventions, then the message. Neither the conventions nor the feedback is read as a template, and the
// feedback goes inside an untrusted-input block.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { inputVar, type PreparedBindings } from './bindings';
import { type FragmentName, renderPrompt } from './prompt';
import { type RenderValues, wrapUntrusted } from './render';
import { markUntrusted } from './untrusted';

/** The convention files a prompt starts with when `project.yaml` names none, in order. One that doesn't exist is skipped. */
export const DEFAULT_CONVENTIONS = ['AGENTS.md', 'CLAUDE.md'] as const;

/** The `source` of the untrusted-input block that holds a corrective try's problems. */
export const FEEDBACK_SOURCE = 'the problems found in your last output';

/** The heading of the step's own prompt in the record `prompt.md` keeps, there only when a convention precedes it. */
export const TASK_HEADING = '## Your task';

export interface AgentPromptOptions {
  /** The repository's `.sail/`. The workspace is the directory that holds it. */
  sailDir: string;
  /** The prompt's absolute path. */
  file: string;
  bindings: PreparedBindings;
  /** The `INPUT_<NAME>` variables: where this try's `$STAGE_IN` holds each binding. */
  inputs: Readonly<Record<string, string>>;
  /** `project.yaml`'s `conventions`, each relative to the workspace. Left out, the defaults are used. */
  conventions?: readonly string[];
  /** The messages of the validation failure this try corrects, appended last inside one untrusted-input block. */
  feedback?: readonly string[];
}

export type AgentPrompt =
  | {
      ok: true;
      /** The record `prompt.md` keeps: the conventions, `## Your task` and the message. */
      text: string;
      /** What the session is sent: the step's prompt, then a corrective try's feedback. */
      message: string;
      /** The convention files' text, for the harness's system prompt; absent when the step has none. */
      conventionsText?: string;
      /** The untrusted values the prompt prints. */
      untrusted: number;
      fragments: { name: FragmentName; origin: string }[];
      /** The convention files the prompt starts with, each relative to the workspace, in order. */
      conventions: string[];
    }
  /** Why there is no prompt: a file that can't be read, a template that can't be rendered. */
  | { ok: false; message: string };

/** The record of a prompt: `message` alone, or the conventions, `## Your task` and `message`. */
export const promptRecord = (conventionsText: string | undefined, message: string): string =>
  conventionsText === undefined ? message : `${conventionsText}\n\n${TASK_HEADING}\n\n${message}`;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The values a prompt or a document's template is rendered with, by binding name: a value as its schema parsed it,
 * with the strings the schema marks untrusted marked so; a file as where `$STAGE_IN` holds its copy; and null for a
 * binding left unbound, so `#if` can read it.
 */
export function bindingValues(bindings: PreparedBindings, inputs: Readonly<Record<string, string>>): RenderValues {
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
    rendered = renderPrompt({ sailDir, file, values: bindingValues(bindings, inputs) });
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
  const sections = conventions.files.map(({ path, text }) => `## Repository conventions: ${path}\n\n${text.trimEnd()}`);
  const parts = [rendered.text.trimEnd()];
  if (feedback.length > 0) {
    const intro = 'Your last output was rejected. Fix each problem below, then submit again.';
    const problems = wrapUntrusted(feedback.map((message) => message.trimEnd()).join('\n\n'), FEEDBACK_SOURCE);
    parts.push(`## Fix your last output\n\n${intro}\n\n${problems}`);
  }
  const message = `${parts.join('\n\n')}\n`;
  const conventionsText = sections.length > 0 ? sections.join('\n\n') : undefined;
  return {
    ok: true,
    text: promptRecord(conventionsText, message),
    message,
    ...(conventionsText === undefined ? {} : { conventionsText }),
    untrusted: rendered.untrusted + (feedback.length > 0 ? 1 : 0),
    fragments: rendered.fragments,
    conventions: conventions.files.map(({ path }) => path),
  };
}
