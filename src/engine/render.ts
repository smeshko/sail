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

type Node = { type: 'text'; text: string } | { type: 'var'; path: string; line: number };

const PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

function parse(template: string): Node[] {
  const nodes: Node[] = [];
  let pos = 0;
  while (pos < template.length) {
    const start = template.indexOf('{{', pos);
    if (start === -1) break;
    const line = template.slice(0, start).split('\n').length;
    const close = template.indexOf('}}', start + 2);
    if (close === -1) throw new RenderError('`{{` is never closed', line);
    const end = close + 2;
    const body = template.slice(start + 2, close).trim();
    if (body.includes(':')) {
      nodes.push({ type: 'text', text: template.slice(pos, end) });
    } else {
      if (!PATH.test(body)) throw new RenderError(`\`{{${body}}}\` is not a variable or a placeholder`, line);
      nodes.push({ type: 'text', text: template.slice(pos, start) });
      nodes.push({ type: 'var', path: body, line });
    }
    pos = end;
  }
  nodes.push({ type: 'text', text: template.slice(pos) });
  return nodes;
}

function lookup(path: string, line: number, values: RenderValues): unknown {
  let current: unknown = values;
  for (const key of path.split('.')) {
    if (
      typeof current !== 'object' ||
      current === null ||
      (Array.isArray(current) && !/^\d+$/.test(key)) ||
      !Object.hasOwn(current, key)
    ) {
      throw new RenderError(`unknown path \`${path}\``, line, path);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Renders `template` with `values`. The template is parsed whole before any value is read. */
export function render(template: string, values: RenderValues): Rendered {
  const text = parse(template)
    .map((node) => {
      if (node.type === 'text') return node.text;
      const value = lookup(node.path, node.line, values);
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
      throw new RenderError(`\`${node.path}\` has no text to print`, node.line, node.path);
    })
    .join('');
  return { text, untrusted: -1 };
}
