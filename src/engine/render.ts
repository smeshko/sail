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

/** What `untrustedInput()` makes, and the only thing that is one: an object read back from JSON is not. */
class Marked implements UntrustedInput {
  readonly text: string;
  readonly source: string;

  constructor(text: string, source: string) {
    this.text = text;
    this.source = source;
  }
}

/** Marks `text` as written by someone outside the run: the renderer wraps it wherever a template prints it. */
export function untrustedInput(text: string, source: string): UntrustedInput {
  return new Marked(text, source);
}

export function isUntrustedInput(value: unknown): value is UntrustedInput {
  return value instanceof Marked;
}

/** `<` becomes `&lt;` wherever `untrusted-input` follows it, so the text can't close the wrapper or open another. */
const LOOKALIKE = /<(?=\s*\/?\s*untrusted-input)/gi;

function escapeSource(source: string): string {
  return source
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/\r?\n|\r/g, '&#10;');
}

/** `text` inside `<untrusted-input source="…">`: three lines as a block, one line inline. */
export function wrapUntrusted(text: string, source: string, form: 'block' | 'inline' = 'block'): string {
  const open = `<untrusted-input source="${escapeSource(source)}">`;
  const safe = text.replace(LOOKALIKE, '&lt;');
  if (form === 'inline') return `${open}${safe}</untrusted-input>`;
  return `${open}\n${safe.replace(/\r?\n$/, '')}\n</untrusted-input>`;
}

type Node =
  | { type: 'text'; text: string }
  | { type: 'var'; path: string; line: number; alone: boolean }
  | { type: 'if'; path: string; line: number; taken: Node[]; otherwise: Node[] | undefined }
  | { type: 'each'; path: string; line: number; body: Node[] };

const PATH = /^(?:[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)*$/;
const BLOCK_PATH = /^#(if|each)\s+(\S+)$/;

interface Open {
  kind: 'if' | 'each';
  line: number;
  node: Extract<Node, { type: 'if' | 'each' }>;
  into: Node[];
}

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Open[] = [];
  let into = root;
  let pos = 0;
  const lineAt = (index: number) => template.slice(0, index).split('\n').length;

  while (pos < template.length) {
    const start = template.indexOf('{{', pos);
    if (start === -1) break;
    const line = lineAt(start);
    const close = template.indexOf('}}', start + 2);
    if (close === -1) throw new RenderError('`{{` is never closed', line);
    const end = close + 2;
    const body = template.slice(start + 2, close).trim();

    const lineStart = template.lastIndexOf('\n', start - 1) + 1;
    const before = template.slice(lineStart, start);
    const after = /^[ \t]*(\r?\n|$)/.exec(template.slice(end));
    const alone = /^[ \t]*$/.test(before) && after !== null;

    if (body.includes(':')) {
      into.push({ type: 'text', text: template.slice(pos, end) });
      pos = end;
      continue;
    }

    const block = BLOCK_PATH.exec(body);
    const isBlockTag = block !== null || body === 'else' || body === '/if' || body === '/each';
    const textEnd = isBlockTag && alone ? lineStart : start;
    const next = isBlockTag && alone && after !== null ? end + after[0].length : end;
    into.push({ type: 'text', text: template.slice(pos, textEnd) });

    if (block !== null) {
      const [, kind, path] = block as unknown as [string, 'if' | 'each', string];
      if (!PATH.test(path)) throw new RenderError(`\`${path}\` is not a path`, line, path);
      const node: Open['node'] =
        kind === 'if'
          ? { type: 'if', path, line, taken: [], otherwise: undefined }
          : { type: 'each', path, line, body: [] };
      into.push(node);
      stack.push({ kind, line, node, into });
      into = node.type === 'if' ? node.taken : node.body;
    } else if (body === 'else') {
      const open = stack.at(-1);
      if (open === undefined || open.node.type !== 'if') throw new RenderError('`{{else}}` has no `{{#if}}`', line);
      if (open.node.otherwise !== undefined) throw new RenderError('`{{else}}` comes twice', line);
      open.node.otherwise = [];
      into = open.node.otherwise;
    } else if (body === '/if' || body === '/each') {
      const open = stack.pop();
      if (open === undefined) throw new RenderError(`\`{{${body}}}\` closes nothing`, line);
      if (`/${open.kind}` !== body) {
        throw new RenderError(`\`{{${body}}}\` closes the \`{{#${open.kind}}}\` of line ${open.line}`, line);
      }
      into = open.into;
    } else if (body === 'this' || (PATH.test(body) && !body.startsWith('#'))) {
      into.push({ type: 'var', path: body, line, alone });
    } else {
      throw new RenderError(`\`{{${body}}}\` is not a variable, a block or a placeholder`, line);
    }
    pos = next;
  }

  const open = stack.at(-1);
  if (open !== undefined) throw new RenderError(`\`{{#${open.kind}}}\` is never closed`, open.line);
  into.push({ type: 'text', text: template.slice(pos) });
  return root;
}

type Scope = readonly unknown[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isUntrustedInput(value);
}

/** The child of `from` at `key`: an own key of an object, or an index of a list. */
function child(from: unknown, key: string): { found: true; value: unknown } | { found: false } {
  if (Array.isArray(from)) {
    if (/^\d+$/.test(key) && Object.hasOwn(from, key)) return { found: true, value: from[Number(key)] };
  } else if (isObject(from) && Object.hasOwn(from, key)) {
    return { found: true, value: from[key] };
  }
  return { found: false };
}

function lookup(path: string, line: number, values: RenderValues, items: Scope): unknown {
  const [first = '', ...rest] = path.split('.');
  let current: unknown;
  if (first === 'this') {
    if (items.length === 0) throw new RenderError('`this` is only known inside `{{#each}}`', line, path);
    current = items.at(-1);
  } else {
    const container = [...items].reverse().find((item) => child(item, first).found);
    const found = child(container ?? values, first);
    if (!found.found) throw new RenderError(`unknown path \`${path}\``, line, path);
    current = found.value;
  }
  for (const key of rest) {
    const found = child(current, key);
    if (!found.found) throw new RenderError(`unknown path \`${path}\``, line, path);
    current = found.value;
  }
  return current;
}

function truthy(value: unknown): boolean {
  if (isUntrustedInput(value)) return value.text !== '';
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

/** Renders `template` with `values`. The template is parsed whole before any value is read. */
export function render(template: string, values: RenderValues): Rendered {
  let untrusted = 0;

  const fill = (nodes: Node[], items: Scope): string => {
    let out = '';
    for (const node of nodes) {
      if (node.type === 'text') {
        out += node.text;
      } else if (node.type === 'var') {
        const value = lookup(node.path, node.line, values, items);
        if (isUntrustedInput(value)) {
          untrusted += 1;
          out += wrapUntrusted(value.text, value.source, node.alone ? 'block' : 'inline');
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          out += String(value);
        } else {
          throw new RenderError(`\`${node.path}\` has no text to print`, node.line, node.path);
        }
      } else if (node.type === 'if') {
        const branch = truthy(lookup(node.path, node.line, values, items)) ? node.taken : node.otherwise;
        if (branch !== undefined) out += fill(branch, items);
      } else {
        const list = lookup(node.path, node.line, values, items);
        if (list === null || list === undefined) continue;
        if (!Array.isArray(list)) throw new RenderError(`\`${node.path}\` is not a list`, node.line, node.path);
        for (const item of list) out += fill(node.body, [...items, item]);
      }
    }
    return out;
  };

  return { text: fill(parse(template), []), untrusted: untrusted };
}
