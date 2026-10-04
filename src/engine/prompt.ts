// renderPrompt(): a step's prompt followed by the shared fragments, each rendered on its own with the same values so an
// error names its file. A repository shadows a fragment with `.sail/prompts/_shared/<name>.md`.
import type { RenderValues } from './render';

export const FRAGMENTS = ['untrusted-input', 'finish'] as const;
export type FragmentName = (typeof FRAGMENTS)[number];

export interface Fragment {
  name: FragmentName;
  text: string;
  /** `builtin`, or `repo:<path from the repository's root>`. */
  origin: string;
}

/** The repository's own fragment when it has one, the built-in otherwise. Nothing is read until it is asked for. */
export function readFragment(_sailDir: string, name: FragmentName): Fragment {
  return { name, text: '', origin: '' };
}

export interface RenderedPrompt {
  text: string;
  untrusted: number;
  fragments: { name: FragmentName; origin: string }[];
}

/** `file` is the prompt's absolute path. The parts are trimmed, joined by a blank line, and an empty one is left out. */
export function renderPrompt(_options: { sailDir: string; file: string; values: RenderValues }): RenderedPrompt {
  return { text: '', untrusted: -1, fragments: [] };
}
