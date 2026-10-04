// The template renderer: `{{path}}`, `{{#if path}}…{{else}}…{{/if}}` and `{{#each path}}…{{/each}}`. A tag with a colon is
// a placeholder for the agent and comes out untouched. Anything else is a RenderError. A value is inserted as it is and
// never read as a template. This module imports nothing: a test asserts it.

export type RenderValues = Readonly<Record<string, unknown>>;

/** A template that can't be rendered: `path` is the variable at fault, if any, and `line` counts from 1. */
export class RenderError extends Error {
  readonly line: number;
  readonly path: string | undefined;

  constructor(reason: string, line: number, path?: string, file?: string) {
    super(`${file === undefined ? '' : `${file}: `}line ${line}: ${reason}`);
    this.name = 'RenderError';
    this.line = line;
    this.path = path;
  }
}

export interface Rendered {
  text: string;
  /** The untrusted values printed. */
  untrusted: number;
}

export interface UntrustedInput {
  readonly text: string;
  readonly source: string;
}

/** Marks `text` as written by someone outside the run: the renderer wraps it wherever a template prints it. */
export function untrustedInput(_text: string, _source: string): UntrustedInput {
  return { text: '', source: '' };
}

export function isUntrustedInput(_value: unknown): _value is UntrustedInput {
  return false;
}

/** `text` inside `<untrusted-input source="…">`: three lines as a block, one line inline. */
export function wrapUntrusted(_text: string, _source: string, _form: 'block' | 'inline' = 'block'): string {
  return '';
}

/** Renders `template` with `values`. The template is parsed whole before any value is read. */
export function render(_template: string, _values: RenderValues): Rendered {
  return { text: '', untrusted: -1 };
}
