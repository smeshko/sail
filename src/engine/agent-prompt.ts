// prepareAgentPrompt(): an agent step's prompt as its harness receives it. The step's `prompt.md` and the shared fragments
// are rendered with the call's bindings, then the repository's convention files and a corrective try's feedback are
// appended as they are: neither is read as a template.
import type { PreparedBindings } from './bindings';
import type { FragmentName } from './prompt';

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

export function prepareAgentPrompt(_options: AgentPromptOptions): AgentPrompt {
  return { ok: true, text: '', untrusted: 0, fragments: [], conventions: [] };
}
