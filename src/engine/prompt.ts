// renderPrompt(): a step's prompt followed by the shared fragments, each rendered on its own with the same values so an
// error names its file. A repository shadows a fragment with `.sail/prompts/_shared/<name>.md`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RenderError, type RenderValues, render } from './render';
import { origin } from './roster';

export const FRAGMENTS = ['untrusted-input', 'finish'] as const;
export type FragmentName = (typeof FRAGMENTS)[number];

export interface Fragment {
  name: FragmentName;
  text: string;
  /** `builtin`, or `repo:<path from the repository's root>`. */
  origin: string;
}

/** The repository's own fragment when it has one, the built-in otherwise. Nothing is read until it is asked for. */
export function readFragment(sailDir: string, name: FragmentName): Fragment {
  const own = join(sailDir, 'prompts', '_shared', `${name}.md`);
  if (existsSync(own)) return { name, text: readFileSync(own, 'utf8'), origin: origin(dirname(sailDir), own) };
  const builtin = join(import.meta.dir, '..', 'builtins', 'prompts', '_shared', `${name}.md`);
  return { name, text: readFileSync(builtin, 'utf8'), origin: 'builtin' };
}

export interface RenderedPrompt {
  text: string;
  untrusted: number;
  fragments: { name: FragmentName; origin: string }[];
}

/** `file` is the prompt's absolute path. The parts are trimmed, joined by a blank line, and an empty one is left out. */
export function renderPrompt(options: { sailDir: string; file: string; values: RenderValues }): RenderedPrompt {
  const { sailDir, file, values } = options;
  const fragments = FRAGMENTS.map((name) => readFragment(sailDir, name));
  const parts = [
    { label: origin(dirname(sailDir), file).slice('repo:'.length), text: readFileSync(file, 'utf8') },
    ...fragments.map((fragment) => ({ label: fragment.origin, text: fragment.text })),
  ];
  let untrusted = 0;
  const rendered: string[] = [];
  for (const part of parts) {
    try {
      const result = render(part.text, values);
      untrusted += result.untrusted;
      if (result.text.trim() !== '') rendered.push(result.text.trimEnd());
    } catch (error) {
      if (error instanceof RenderError) {
        const reason = error.message.replace(/^line \d+: /, '');
        throw new RenderError(reason, error.line, error.path, part.label);
      }
      throw error;
    }
  }
  return {
    text: `${rendered.join('\n\n')}\n`,
    untrusted,
    fragments: fragments.map(({ name, origin }) => ({ name, origin })),
  };
}
