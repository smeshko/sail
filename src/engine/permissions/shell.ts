// A shell parser for the permission engine: it turns a command string into every simple command a shell would run for
// it, nested ones included, and refuses, with a reason, any construct outside the closed list it understands (D7, as
// ADW-478 revises it: loops, conditionals, case, groups and subshells are read, select and functions still refused).
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
  /** Written `NAME+=value`: the value is appended to what the name held. */
  readonly append?: true;
}

export interface SimpleCommand {
  readonly kind: 'simple';
  /** The command as written, for reasons. */
  readonly text: string;
  readonly assignments: readonly Assignment[];
  /** The argv, unquoted. */
  readonly words: readonly Word[];
  readonly redirections: readonly Redirection[];
}

interface CompoundBase {
  /** The construct as written, trailing redirections included, for reasons. */
  readonly text: string;
  /** Those after its closing keyword, which apply to the whole construct. */
  readonly redirections: readonly Redirection[];
}

export interface Group extends CompoundBase {
  readonly kind: 'group' | 'subshell';
  readonly body: readonly Pipeline[];
}

export interface ForLoop extends CompoundBase {
  readonly kind: 'for';
  readonly name: string;
  /** Absent when there is no `in`: the loop runs over `"$@"`. */
  readonly words?: readonly Word[];
  readonly body: readonly Pipeline[];
}

export interface WhileLoop extends CompoundBase {
  readonly kind: 'while' | 'until';
  readonly condition: readonly Pipeline[];
  readonly body: readonly Pipeline[];
}

export interface IfClause extends CompoundBase {
  readonly kind: 'if';
  readonly clauses: readonly { readonly condition: readonly Pipeline[]; readonly body: readonly Pipeline[] }[];
  readonly otherwise?: readonly Pipeline[];
}

export interface CaseClause extends CompoundBase {
  readonly kind: 'case';
  readonly word: Word;
  readonly arms: readonly { readonly patterns: readonly Word[]; readonly body: readonly Pipeline[] }[];
}

export type Compound = Group | ForLoop | WhileLoop | IfClause | CaseClause;
export type Command = SimpleCommand | Compound;

/** Commands joined by `|`. A list joins pipelines by `;`, `&&`, `||`, `&` and newlines. */
export interface Pipeline {
  readonly commands: readonly Command[];
  /** Ended by `&`: it runs beside what follows. */
  readonly background: boolean;
  /** Runs only on the exit status of the pipeline before it: it follows `&&` or `||`. */
  readonly conditional: boolean;
  /** Followed by `||`: what follows runs only when it fails. */
  readonly orElse?: boolean;
}

export type Parsed =
  | { readonly ok: true; readonly list: readonly Pipeline[] }
  | { readonly ok: false; readonly reason: string };

/** The lists a compound command runs, in source order: none for a simple command. */
export function bodies(command: Command): readonly (readonly Pipeline[])[] {
  switch (command.kind) {
    case 'simple':
      return [];
    case 'group':
    case 'subshell':
    case 'for':
      return [command.body];
    case 'while':
    case 'until':
      return [command.condition, command.body];
    case 'if':
      return [...command.clauses.flatMap((clause) => [clause.condition, clause.body]), command.otherwise ?? []];
    case 'case':
      return command.arms.map((arm) => arm.body);
  }
}

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

/** Where a list stops: at one of these reserved words, at `)`, or at a case arm's end. The stop is left unread. */
interface Stops {
  readonly words: readonly string[];
  readonly paren: boolean;
  readonly arm: boolean;
}

const TOP: Stops = { words: [], paren: false, arm: false };
const CLOSERS = ['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}'];
const KEYWORD_AT =
  /^(?:for|while|until|if|case|then|elif|else|fi|do|done|esac|in|select|function|\{|\})(?=$|[ \t\n;&|<>()])/;

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
    // Not readonly: a line continuation is cut out of it where a token is read (`squash`).
    private src: string,
    private depth: number,
  ) {
    if (depth > MAX_DEPTH) throw new Refusal(`substitutions nested deeper than ${MAX_DEPTH} levels`);
  }

  program(): Pipeline[] {
    const list = this.list(TOP);
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

  /**
   * Cuts the line continuations at `at` out of the source. bash removes a backslash-newline before it reads a token,
   * everywhere but in single quotes, comments and a quoted heredoc's body, so a token split by one (`&\`+newline+`&`,
   * `$\`+newline+`{X}`, a heredoc delimiter) is the token joined. Only ever called where a character is read fresh:
   * never on the character an escaping backslash takes, nor inside single quotes, a comment or a heredoc body.
   */
  private squash(at: number): void {
    while (this.src[at] === '\\' && this.src[at + 1] === '\n')
      this.src = this.src.slice(0, at) + this.src.slice(at + 2);
  }

  /** The character at the read position, a line continuation there removed first. */
  private peek(): string | undefined {
    this.squash(this.pos);
    return this.src[this.pos];
  }

  /** The character `offset` places on, each one before it read fresh: what follows `$`, `<`, `>` or `&`. */
  private after(offset: number): string | undefined {
    for (let k = 0; k <= offset; k++) this.squash(this.pos + k);
    return this.src[this.pos + offset];
  }

  /** The character after an escaping backslash: taken as it stands, a newline included. */
  private escaped(): string | undefined {
    return this.src[this.pos + 1];
  }

  /** Squashes from `from` while the characters match `run`: before a name or an operator is matched as a whole. */
  private squashRun(from: number, run: RegExp): void {
    for (let at = from; ; at++) {
      this.squash(at);
      const c = this.src[at];
      if (c === undefined || !run.test(c)) return;
    }
  }

  private startsWith(text: string): boolean {
    for (let k = 0; k < text.length; k++) if (this.after(k) !== text[k]) return false;
    return true;
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

  /** Up to the newline, read as it stands: a backslash before it continues no comment. */
  private comment(): void {
    while (!this.atEnd() && this.src[this.pos] !== '\n') this.pos++;
  }

  /** The reserved word at the read position, if the word there is exactly one. */
  private keywordAt(): string | undefined {
    this.squashRun(this.pos, /[A-Za-z{}]/);
    return KEYWORD_AT.exec(this.src.slice(this.pos, this.pos + 10))?.[0];
  }

  /** Pipelines up to the end, or up to one of `stops`, which is left for the caller. */
  private list(stops: Stops): Pipeline[] {
    const list: Pipeline[] = [];
    let conditional = false;
    for (;;) {
      this.blank();
      const c = this.peek();
      if (c === undefined) return list;
      if (c === ')') {
        if (stops.paren) return list;
        throw new Refusal('an unmatched )');
      }
      if (stops.arm && this.armEnd()) return list;
      const keyword = this.keywordAt();
      if (keyword !== undefined && stops.words.includes(keyword)) return list;
      if (c === ';' || c === '&' || c === '|') throw new Refusal(`a command can't start with ${c}`);
      const commands = this.pipeline();
      const follows = conditional;
      conditional = false;
      this.spaces();
      if (this.startsWith('&&') || this.startsWith('||')) {
        const op = this.src.slice(this.pos, this.pos + 2);
        this.pos += 2;
        this.blank();
        this.followed(op);
        list.push({ commands, background: false, conditional: follows, ...(op === '||' && { orElse: true }) });
        conditional = true;
      } else if (stops.arm && this.armEnd()) {
        list.push({ commands, background: false, conditional: follows });
        return list;
      } else if (this.startsWith(';;')) {
        throw new Refusal('a case clause (;;)');
      } else if (this.peek() === ';') {
        this.pos++;
        list.push({ commands, background: false, conditional: follows });
      } else if (this.peek() === '&') {
        this.pos++;
        list.push({ commands, background: true, conditional: follows });
      } else {
        list.push({ commands, background: false, conditional: follows });
      }
    }
  }

  /** At `;;`, `;&` or `;;&`, which end a case arm. */
  private armEnd(): boolean {
    return this.startsWith(';;') || this.startsWith(';&');
  }

  /** After `op`, a command must follow. */
  private followed(op: string): void {
    const c = this.peek();
    const keyword = this.keywordAt();
    if (
      c === undefined ||
      c === ')' ||
      c === ';' ||
      c === '&' ||
      c === '|' ||
      (keyword !== undefined && CLOSERS.includes(keyword))
    ) {
      throw new Refusal(`a command that ends with ${op}`);
    }
  }

  private pipeline(): Command[] {
    const commands = [this.command()];
    for (;;) {
      this.spaces();
      if (this.peek() !== '|' || this.startsWith('||')) return commands;
      this.pos += this.startsWith('|&') ? 2 : 1;
      this.blank();
      this.followed('|');
      commands.push(this.command());
    }
  }

  /** A compound command when a reserved word or `(` starts it, a simple command otherwise. */
  private command(): Command {
    this.spaces();
    const start = this.pos;
    if (this.peek() === '(' && this.after(1) !== '(') return this.subshell(start);
    switch (this.keywordAt()) {
      case 'for':
        return this.forLoop(start);
      case 'while':
      case 'until':
        return this.whileLoop(start);
      case 'if':
        return this.ifClause(start);
      case 'case':
        return this.caseClause(start);
      case '{':
        return this.group(start);
      default:
        return this.simple();
    }
  }

  /** The commands of one body, read a level deeper, up to one of `stops`. */
  private body(stops: Stops, construct: string, empty = false): Pipeline[] {
    this.enter();
    const list = this.list(stops);
    this.depth--;
    if (list.length === 0 && !empty) throw new Refusal(`${construct} with an empty body`);
    return list;
  }

  /** Consumes the reserved word `keyword`, or refuses `construct` for lacking it. */
  private expect(keyword: string, construct: string): void {
    this.blank();
    if (this.keywordAt() !== keyword) throw new Refusal(`${construct} without its ${keyword}`);
    this.pos += keyword.length;
  }

  /** What follows a closing keyword: redirections for the whole construct, and then a separator or the end. */
  private closing(start: number, close: string): { text: string; redirections: Redirection[] } {
    const redirections: Redirection[] = [];
    for (;;) {
      this.spaces();
      const redirection = this.redirection();
      if (redirection === undefined) break;
      redirections.push(redirection);
    }
    const c = this.peek();
    if (c !== undefined && !'\n;&|)#'.includes(c)) throw new Refusal(`a word after ${close}`);
    return { text: this.src.slice(start, this.pos).trim(), redirections };
  }

  private group(start: number): Command {
    this.pos += 1;
    const body = this.body({ words: ['}'], paren: false, arm: false }, 'a brace group');
    this.expect('}', 'a brace group');
    return { kind: 'group', body, ...this.closing(start, '}') };
  }

  private subshell(start: number): Command {
    this.pos += 1;
    const body = this.body({ words: [], paren: true, arm: false }, 'a subshell');
    if (this.peek() !== ')') throw new Refusal('a subshell without its )');
    this.pos++;
    return { kind: 'subshell', body, ...this.closing(start, ')') };
  }

  private forLoop(start: number): Command {
    this.pos += 3;
    this.spaces();
    if (this.startsWith('((')) throw new Refusal('an arithmetic for loop');
    const c = this.peek();
    if (c === undefined || META.has(c)) throw new Refusal('a for loop without a name');
    const name = this.word().raw;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Refusal(`a for loop over ${name}, which isn't a name`);
    this.blank();
    let words: Word[] | undefined;
    if (this.keywordAt() === 'in') {
      this.pos += 2;
      words = [];
      for (;;) {
        this.spaces();
        const next = this.peek();
        if (next === undefined || next === '\n' || next === ';') break;
        if (next === '#') {
          this.comment();
          break;
        }
        if (META.has(next)) throw new Refusal(`a for loop word list holding ${next}`);
        words.push(this.word());
      }
    }
    this.spaces();
    if (this.peek() === ';') this.pos++;
    this.expect('do', 'a for loop');
    const body = this.body({ words: ['done'], paren: false, arm: false }, 'a for loop');
    this.expect('done', 'a for loop');
    const tail = this.closing(start, 'done');
    return { kind: 'for', name, ...(words === undefined ? {} : { words }), body, ...tail };
  }

  private whileLoop(start: number): Command {
    const kind = this.keywordAt() === 'until' ? 'until' : 'while';
    const construct = kind === 'until' ? 'an until loop' : 'a while loop';
    this.pos += kind.length;
    const condition = this.body({ words: ['do'], paren: false, arm: false }, construct);
    this.expect('do', construct);
    const body = this.body({ words: ['done'], paren: false, arm: false }, construct);
    this.expect('done', construct);
    return { kind, condition, body, ...this.closing(start, 'done') };
  }

  private ifClause(start: number): Command {
    const clauses: { condition: Pipeline[]; body: Pipeline[] }[] = [];
    let otherwise: Pipeline[] | undefined;
    this.pos += 2;
    for (;;) {
      const condition = this.body({ words: ['then'], paren: false, arm: false }, 'an if');
      this.expect('then', 'an if');
      const body = this.body({ words: ['elif', 'else', 'fi'], paren: false, arm: false }, 'an if');
      clauses.push({ condition, body });
      this.blank();
      const next = this.keywordAt();
      if (next === 'elif') {
        this.pos += 4;
        continue;
      }
      if (next === 'else') {
        this.pos += 4;
        otherwise = this.body({ words: ['fi'], paren: false, arm: false }, 'an if');
      }
      break;
    }
    this.expect('fi', 'an if');
    return {
      kind: 'if',
      clauses,
      ...(otherwise === undefined ? {} : { otherwise }),
      ...this.closing(start, 'fi'),
    };
  }

  private caseClause(start: number): Command {
    this.pos += 4;
    this.spaces();
    const c = this.peek();
    if (c === undefined || META.has(c)) throw new Refusal('a case without a word');
    const word = this.word();
    this.expect('in', 'a case');
    const arms: { patterns: Word[]; body: Pipeline[] }[] = [];
    for (;;) {
      this.blank();
      if (this.keywordAt() === 'esac') {
        this.pos += 4;
        break;
      }
      if (this.atEnd()) throw new Refusal('a case without its esac');
      if (this.peek() === '(') this.pos++;
      const patterns: Word[] = [];
      for (;;) {
        this.spaces();
        const first = this.peek();
        if (first === undefined || META.has(first)) throw new Refusal('a case pattern missing');
        patterns.push(this.word());
        this.spaces();
        if (this.peek() !== '|') break;
        this.pos++;
      }
      if (this.peek() !== ')') throw new Refusal('a case pattern without its )');
      this.pos++;
      const body = this.body({ words: ['esac'], paren: false, arm: true }, 'a case arm', true);
      arms.push({ patterns, body });
      if (this.startsWith(';;&')) this.pos += 3;
      else if (this.startsWith(';;') || this.startsWith(';&')) this.pos += 2;
    }
    return { kind: 'case', word, arms, ...this.closing(start, 'esac') };
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
      if (c === '&' && this.after(1) !== '>') break;
      if (c === '#') {
        this.comment();
        break;
      }
      if (c === '(') {
        if (words.length > 0) throw new Refusal('a function definition');
        throw new Refusal(this.after(1) === '(' ? 'an arithmetic command' : 'a subshell ( … )');
      }
      const redirection = this.redirection();
      if (redirection !== undefined) {
        redirections.push(redirection);
        continue;
      }
      if (words.length === 0 && this.assignmentAhead()) {
        const name = (NAME.exec(this.src.slice(this.pos)) as RegExpExecArray)[0];
        const append = this.src[this.src.indexOf('=', this.pos) - 1] === '+';
        this.pos = this.src.indexOf('=', this.pos) + 1;
        if (this.peek() === '(') throw new Refusal(`an array assignment to ${name}`);
        assignments.push(append ? { name, value: this.word(), append } : { name, value: this.word() });
        continue;
      }
      const word = this.word();
      const keyword = KEYWORDS.get(word.raw);
      if (words.length === 0 && keyword !== undefined) throw new Refusal(keyword);
      words.push(word);
    }
    return { kind: 'simple', text: this.src.slice(start, this.pos).trim(), assignments, words, redirections };
  }

  /** Whether `NAME=` or `NAME+=` starts here, a line continuation inside it removed. */
  private assignmentAhead(): boolean {
    this.squashRun(this.pos, /[A-Za-z0-9_+]/);
    return ASSIGNMENT.test(this.src.slice(this.pos));
  }

  private redirection(): Redirection | undefined {
    const c = this.peek();
    if ((c === '<' || c === '>') && this.after(1) === '(') throw new Refusal(`a process substitution ${c}( … )`);
    this.squashRun(this.pos, /[0-9<>&|-]/);
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

  /** An unquoted backslash: the next character is literal. A backslash-newline never gets here (`squash`). */
  private escape(state: WordState): void {
    const next = this.escaped();
    this.pos += 2;
    state.text += next ?? '\\';
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
        const next = this.escaped();
        if (next !== undefined && (next === '$' || next === '`' || next === '\\' || next === end)) {
          state.text += next;
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
    const next = this.after(1);
    if (next === '(') {
      if (this.after(2) === '(') throw new Refusal('an arithmetic expansion $(( … ))');
      this.pos += 2;
      this.enter();
      const list = this.list({ words: [], paren: true, arm: false });
      this.depth--;
      if (this.peek() !== ')') throw new Refusal('an unterminated $(');
      this.pos++;
      state.nested.push(list);
    } else if (next === '{') {
      this.squashRun(this.pos + 2, /[A-Za-z0-9_]/);
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
      this.squashRun(this.pos + 1, /[A-Za-z0-9_]/);
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
      const next = this.escaped();
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

  /** One line of a heredoc's body. An unquoted body's line goes on past a backslash-newline, as bash reads it. */
  private bodyLine(quoted: boolean): string {
    let line = '';
    for (;;) {
      const end = this.src.indexOf('\n', this.pos);
      const stop = end === -1 ? this.src.length : end;
      const raw = this.src.slice(this.pos, stop);
      this.pos = end === -1 ? this.src.length : end + 1;
      const trailing = /\\*$/.exec(raw)?.[0].length ?? 0;
      if (quoted || end === -1 || trailing % 2 === 0) return line + raw;
      line += raw.slice(0, -1);
    }
  }

  /** The bodies of the heredocs the line just ended opened, each up to its delimiter line. */
  private heredocs(): void {
    for (const { delimiter, strip, heredoc } of this.pending.splice(0)) {
      let body = '';
      for (;;) {
        if (this.atEnd()) throw new Refusal(`a heredoc without its closing ${delimiter} line`);
        const raw = this.bodyLine(heredoc.quoted);
        const line = strip ? raw.replace(/^\t+/, '') : raw;
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
