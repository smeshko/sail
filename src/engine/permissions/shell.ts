// A shell parser for the permission engine: it turns a command string into every simple command a shell would run for
// it, nested ones included, and refuses, with a reason, any construct outside the closed list it understands (D7).
// It parses and never expands: a word keeps its `$VAR` and its substitutions as written.

export type RedirectionOp = '>' | '>>' | '>|' | '<' | '<<<' | '&>' | '&>>' | '<<' | 'dup';

export interface Word {
  /** The value with quotes and escapes removed, substitutions and variables kept as written. */
  readonly text: string;
  /** The word as it stands in the source. */
  readonly raw: string;
  /** No substitution, variable, unquoted glob or `~`: its text is what the shell would see. */
  readonly literal: boolean;
  /** An unquoted `*`, `?` or `[` the shell would expand into file names. */
  readonly glob: boolean;
  /** The `$NAME` and `${NAME}` it holds, and specials such as `$1`. */
  readonly vars: readonly string[];
  /** The parsed body of each `$(…)` and backtick in it. */
  readonly nested: readonly (readonly Pipeline[])[];
}

export interface Heredoc {
  readonly body: string;
  /** A quoted delimiter: the body is data, with nothing expanded. */
  readonly quoted: boolean;
  readonly nested: readonly (readonly Pipeline[])[];
}

export interface Redirection {
  readonly op: RedirectionOp;
  readonly fd?: number;
  readonly target?: Word;
  readonly heredoc?: Heredoc;
}

export interface Assignment {
  readonly name: string;
  readonly value: Word;
}

export interface SimpleCommand {
  /** The command as written, for reasons. */
  readonly text: string;
  readonly assignments: readonly Assignment[];
  /** The argv, unquoted. */
  readonly words: readonly Word[];
  readonly redirections: readonly Redirection[];
}

/** Commands joined by `|`. A list joins pipelines by `;`, `&&`, `||`, `&` and newlines. */
export interface Pipeline {
  readonly commands: readonly SimpleCommand[];
  /** Ended by `&`: it runs beside what follows. */
  readonly background: boolean;
}

export type Parsed =
  | { readonly ok: true; readonly list: readonly Pipeline[] }
  | { readonly ok: false; readonly reason: string };

/** How deep substitutions may nest before a parse refuses. */
export const MAX_DEPTH = 32;

/** Every simple command `text` runs, or why it can't be checked. */
export function parseCommand(text: string): Parsed {
  try {
    return { ok: true, list: new Parser(text, 0).program() };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}

class Refusal extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

const META = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const REDIRECTION = /^(\d*)(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)/;
const KEYWORDS: ReadonlyMap<string, string> = new Map([
  ['for', 'a for loop'],
  ['while', 'a while loop'],
  ['until', 'an until loop'],
  ['if', 'an if'],
  ['case', 'a case'],
  ['select', 'a select'],
  ['function', 'a function definition'],
  ['coproc', 'a coprocess'],
  ['{', 'a brace group'],
  ['[[', 'a [[ test'],
  ['((', 'an arithmetic command'],
  ['!', 'a negated pipeline'],
  ['then', 'the keyword then'],
  ['else', 'the keyword else'],
  ['elif', 'the keyword elif'],
  ['fi', 'the keyword fi'],
  ['do', 'the keyword do'],
  ['done', 'the keyword done'],
  ['esac', 'the keyword esac'],
  ['in', 'the keyword in'],
  ['}', 'the keyword }'],
  [']]', 'the keyword ]]'],
]);

interface WordState {
  text: string;
  literal: boolean;
  glob: boolean;
  vars: string[];
  nested: Pipeline[][];
}

interface MutableHeredoc {
  body: string;
  quoted: boolean;
  nested: Pipeline[][];
}

interface Pending {
  delimiter: string;
  strip: boolean;
  heredoc: MutableHeredoc;
}

function newState(): WordState {
  return { text: '', literal: true, glob: false, vars: [], nested: [] };
}

class Parser {
  private pos = 0;
  private readonly pending: Pending[] = [];

  constructor(
    private readonly src: string,
    private depth: number,
  ) {
    if (depth > MAX_DEPTH) throw new Refusal(`substitutions nested deeper than ${MAX_DEPTH} levels`);
  }

  program(): Pipeline[] {
    const list = this.list(false);
    if (this.pending.length > 0) this.missingDelimiter();
    return list;
  }

  /** The body of an unquoted heredoc: the substitutions it holds. */
  heredocBody(): Pipeline[][] {
    const state = newState();
    this.inner(state, undefined);
    return state.nested;
  }

  private atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  private peek(offset = 0): string | undefined {
    return this.src[this.pos + offset];
  }

  private startsWith(text: string): boolean {
    return this.src.startsWith(text, this.pos);
  }

  /** Spaces and tabs. */
  private spaces(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }

  /** Spaces, comments and newlines, reading the heredoc bodies each newline ends. */
  private blank(): void {
    for (;;) {
      this.spaces();
      if (this.peek() === '#') this.comment();
      if (this.peek() !== '\n') return;
      this.pos++;
      this.heredocs();
    }
  }

  private comment(): void {
    while (!this.atEnd() && this.peek() !== '\n') this.pos++;
  }

  /** Pipelines up to the end, or up to an unquoted `)` when `nested`, which is left for the caller. */
  private list(nested: boolean): Pipeline[] {
    const list: Pipeline[] = [];
    for (;;) {
      this.blank();
      const c = this.peek();
      if (c === undefined) return list;
      if (c === ')') {
        if (nested) return list;
        throw new Refusal('an unmatched )');
      }
      if (c === ';' || c === '&' || c === '|') throw new Refusal(`a command can't start with ${c}`);
      const commands = this.pipeline();
      this.spaces();
      if (this.startsWith('&&') || this.startsWith('||')) {
        const op = this.src.slice(this.pos, this.pos + 2);
        this.pos += 2;
        this.blank();
        this.followed(op);
        list.push({ commands, background: false });
      } else if (this.startsWith(';;')) {
        throw new Refusal('a case clause (;;)');
      } else if (this.peek() === ';') {
        this.pos++;
        list.push({ commands, background: false });
      } else if (this.peek() === '&') {
        this.pos++;
        list.push({ commands, background: true });
      } else {
        list.push({ commands, background: false });
      }
    }
  }

  /** After `op`, a command must follow. */
  private followed(op: string): void {
    const c = this.peek();
    if (c === undefined || c === ')' || c === ';' || c === '&' || c === '|') {
      throw new Refusal(`a command that ends with ${op}`);
    }
  }

  private pipeline(): SimpleCommand[] {
    const commands = [this.simple()];
    for (;;) {
      this.spaces();
      if (this.peek() !== '|' || this.startsWith('||')) return commands;
      this.pos += this.startsWith('|&') ? 2 : 1;
      this.blank();
      this.followed('|');
      commands.push(this.simple());
    }
  }

  private simple(): SimpleCommand {
    const start = this.pos;
    const assignments: Assignment[] = [];
    const words: Word[] = [];
    const redirections: Redirection[] = [];
    for (;;) {
      this.spaces();
      const c = this.peek();
      if (c === undefined || c === '\n' || c === ';' || c === '|' || c === ')') break;
      if (c === '&' && this.peek(1) !== '>') break;
      if (c === '#') {
        this.comment();
        break;
      }
      if (c === '(') {
        if (words.length > 0) throw new Refusal('a function definition');
        throw new Refusal(this.peek(1) === '(' ? 'an arithmetic command' : 'a subshell ( … )');
      }
      const redirection = this.redirection();
      if (redirection !== undefined) {
        redirections.push(redirection);
        continue;
      }
      if (words.length === 0 && ASSIGNMENT.test(this.src.slice(this.pos))) {
        const name = (NAME.exec(this.src.slice(this.pos)) as RegExpExecArray)[0];
        this.pos = this.src.indexOf('=', this.pos) + 1;
        if (this.peek() === '(') throw new Refusal(`an array assignment to ${name}`);
        assignments.push({ name, value: this.word() });
        continue;
      }
      const word = this.word();
      const keyword = KEYWORDS.get(word.raw);
      if (words.length === 0 && keyword !== undefined) throw new Refusal(keyword);
      words.push(word);
    }
    return { text: this.src.slice(start, this.pos).trim(), assignments, words, redirections };
  }

  private redirection(): Redirection | undefined {
    const c = this.peek();
    if ((c === '<' || c === '>') && this.peek(1) === '(') throw new Refusal(`a process substitution ${c}( … )`);
    const match = REDIRECTION.exec(this.src.slice(this.pos));
    if (match === null) return undefined;
    const digits = match[1] as string;
    const op = match[2] as string;
    if (digits !== '' && op.startsWith('&')) return undefined;
    const fd = digits === '' ? undefined : Number(digits);
    this.pos += match[0].length;
    const at = fd === undefined ? {} : { fd };
    if (op === '<>') throw new Refusal('a read-write redirection <>');
    this.spaces();
    if (op === '<<' || op === '<<-') {
      const delimiter = this.target(op);
      const heredoc: MutableHeredoc = { body: '', quoted: /['"\\]/.test(delimiter.raw), nested: [] };
      this.pending.push({ delimiter: delimiter.text, strip: op === '<<-', heredoc });
      return { op: '<<', ...at, heredoc };
    }
    const target = this.target(op);
    if (op === '>&' || op === '<&') {
      if (/^\d+-?$|^-$/.test(target.raw)) return { op: 'dup', ...at };
      if (op === '<&') throw new Refusal(`an input duplication <&${target.raw}`);
      return { op: '&>', ...at, target };
    }
    return { op: op as RedirectionOp, ...at, target };
  }

  private target(op: string): Word {
    const c = this.peek();
    if (c === undefined || META.has(c)) throw new Refusal(`a redirection ${op} without a target`);
    return this.word();
  }

  private word(): Word {
    const start = this.pos;
    const state = newState();
    while (!this.atEnd()) {
      const c = this.peek() as string;
      if (META.has(c)) break;
      if (c === "'") {
        const close = this.src.indexOf("'", this.pos + 1);
        if (close === -1) throw new Refusal("an unterminated ' quote");
        state.text += this.src.slice(this.pos + 1, close);
        this.pos = close + 1;
      } else if (c === '"') {
        this.pos++;
        this.inner(state, '"');
      } else if (c === '\\') {
        this.escape(state);
      } else if (c === '$') {
        this.dollar(state, false);
      } else if (c === '`') {
        this.backtick(state);
      } else if (c === '*' || c === '?' || c === '[') {
        state.glob = true;
        state.literal = false;
        state.text += c;
        this.pos++;
      } else if (c === '~' && this.pos === start) {
        state.literal = false;
        state.text += c;
        this.pos++;
      } else if (c === '{') {
        this.brace();
        state.text += c;
        this.pos++;
      } else {
        state.text += c;
        this.pos++;
      }
    }
    return { ...state, raw: this.src.slice(start, this.pos) };
  }

  /** An unquoted backslash: the next character is literal, and a newline after it joins the lines. */
  private escape(state: WordState): void {
    const next = this.peek(1);
    this.pos += 2;
    if (next === undefined) state.text += '\\';
    else if (next !== '\n') state.text += next;
  }

  /** An unquoted `{` that opens a brace expansion, such as `{a,b}` or `{1..3}`, which the shell turns into words. */
  private brace(): void {
    let i = this.pos + 1;
    while (i < this.src.length && !META.has(this.src[i] as string) && this.src[i] !== '}') i++;
    if (this.src[i] !== '}') return;
    const inside = this.src.slice(this.pos + 1, i);
    if (inside.includes(',') || inside.includes('..')) throw new Refusal(`a brace expansion {${inside}}`);
  }

  /** The inside of double quotes, up to `end`, or of an unquoted heredoc's body, up to the end of input. */
  private inner(state: WordState, end: '"' | undefined): void {
    for (;;) {
      const c = this.peek();
      if (c === undefined) {
        if (end === undefined) return;
        throw new Refusal('an unterminated " quote');
      }
      if (c === end) {
        this.pos++;
        return;
      }
      if (c === '\\') {
        const next = this.peek(1);
        if (next !== undefined && (next === '$' || next === '`' || next === '\\' || next === end)) {
          state.text += next;
          this.pos += 2;
        } else if (next === '\n') {
          this.pos += 2;
        } else {
          state.text += c;
          this.pos++;
        }
      } else if (c === '$') {
        this.dollar(state, true);
      } else if (c === '`') {
        this.backtick(state);
      } else {
        state.text += c;
        this.pos++;
      }
    }
  }

  private dollar(state: WordState, quoted: boolean): void {
    const start = this.pos;
    const next = this.peek(1);
    if (next === '(') {
      if (this.peek(2) === '(') throw new Refusal('an arithmetic expansion $(( … ))');
      this.pos += 2;
      this.enter();
      const list = this.list(true);
      this.depth--;
      if (this.peek() !== ')') throw new Refusal('an unterminated $(');
      this.pos++;
      state.nested.push(list);
    } else if (next === '{') {
      const close = this.src.indexOf('}', this.pos + 2);
      if (close === -1) throw new Refusal('an unterminated ${');
      const name = this.src.slice(this.pos + 2, close);
      if (!/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/.test(name)) {
        throw new Refusal(`a parameter expansion with an operator: \${${name}}`);
      }
      state.vars.push(name);
      this.pos = close + 1;
    } else if (!quoted && next === "'") {
      throw new Refusal("an ANSI-C quote $'…'");
    } else if (!quoted && next === '"') {
      throw new Refusal('a locale quote $"…"');
    } else if (next !== undefined && /[A-Za-z_]/.test(next)) {
      const name = (NAME.exec(this.src.slice(this.pos + 1)) as RegExpExecArray)[0];
      state.vars.push(name);
      this.pos += 1 + name.length;
    } else if (next !== undefined && /[0-9?#@*$!-]/.test(next)) {
      state.vars.push(next);
      this.pos += 2;
    } else {
      state.text += '$';
      this.pos++;
      return;
    }
    state.text += this.src.slice(start, this.pos);
    state.literal = false;
  }

  private backtick(state: WordState): void {
    const start = this.pos;
    this.pos++;
    let body = '';
    for (;;) {
      const c = this.peek();
      if (c === undefined) throw new Refusal('an unterminated ` substitution');
      if (c === '`') break;
      const next = this.peek(1);
      if (c === '\\' && next !== undefined && (next === '$' || next === '`' || next === '\\')) {
        body += next;
        this.pos += 2;
      } else {
        body += c;
        this.pos++;
      }
    }
    this.pos++;
    state.nested.push(new Parser(body, this.depth + 1).program());
    state.text += this.src.slice(start, this.pos);
    state.literal = false;
  }

  private enter(): void {
    this.depth++;
    if (this.depth > MAX_DEPTH) throw new Refusal(`substitutions nested deeper than ${MAX_DEPTH} levels`);
  }

  /** The bodies of the heredocs the line just ended opened, each up to its delimiter line. */
  private heredocs(): void {
    for (const { delimiter, strip, heredoc } of this.pending.splice(0)) {
      let body = '';
      for (;;) {
        if (this.atEnd()) throw new Refusal(`a heredoc without its closing ${delimiter} line`);
        const end = this.src.indexOf('\n', this.pos);
        const stop = end === -1 ? this.src.length : end;
        const raw = this.src.slice(this.pos, stop);
        const line = strip ? raw.replace(/^\t+/, '') : raw;
        this.pos = end === -1 ? this.src.length : end + 1;
        if (line === delimiter) break;
        body += `${line}\n`;
      }
      heredoc.body = body;
      if (!heredoc.quoted) heredoc.nested = new Parser(body, this.depth + 1).heredocBody();
    }
  }

  private missingDelimiter(): never {
    throw new Refusal(`a heredoc without its closing ${(this.pending[0] as Pending).delimiter} line`);
  }
}
