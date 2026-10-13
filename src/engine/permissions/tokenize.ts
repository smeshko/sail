// The shell tokenizer: a command string becomes segments of words, or it is refused. It evaluates nothing.

/** The control operators that join one segment to the one before it, or start the script (null). */
export type Joiner = '|' | '&&' | '||' | ';' | '&' | '\n' | null;

/**
 * One word: `text` is the literal the shell would pass once quotes and escapes are gone. `unsafe` marks any `$`, backtick,
 * `~`, `{`, `}`, `*`, `?` or `[` that is not inside single quotes, since the shell would expand it.
 */
export interface Word {
  readonly text: string;
  readonly raw: string;
  readonly quoted: boolean;
  readonly unsafe: boolean;
  /** The raw bodies of `$(...)` and backticks in this word, unparsed. */
  readonly substitutions: readonly string[];
}

export interface Redirect {
  readonly op: '>' | '>>' | '>|' | '&>' | '&>>' | '<' | '>&' | '<&';
  readonly fd?: number;
  readonly target: Word;
}

export interface Segment {
  readonly words: readonly Word[];
  readonly redirects: readonly Redirect[];
  readonly before: Joiner;
}

export type Script = readonly Segment[];

/** Thrown for any input the tokenizer does not fully understand. */
export class Unparseable extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

type Builder = {
  text: string;
  raw: string;
  quoted: boolean;
  unsafe: boolean;
  substitutions: string[];
};

interface Pending {
  readonly op: Redirect['op'];
  readonly fd?: number;
}

interface State {
  readonly src: string;
  pos: number;
  word: Builder | null;
  words: Word[];
  redirects: Redirect[];
  pending: Pending | null;
  segments: Segment[];
  before: Joiner;
}

const OPERATOR_CHARS = '|&;()<>\n';
const UNSAFE_CHARS = '~{}*?[';

/** Splits a command into segments. Throws `Unparseable` for anything it cannot fully parse. */
export function tokenize(command: string): Script {
  const state: State = {
    src: command,
    pos: 0,
    word: null,
    words: [],
    redirects: [],
    pending: null,
    segments: [],
    before: null,
  };
  while (state.pos < command.length) {
    const c = command.charAt(state.pos);
    if (c === ' ' || c === '\t') {
      endWord(state);
      state.pos += 1;
    } else if (OPERATOR_CHARS.includes(c)) {
      operator(state);
    } else {
      if (c === '#' && state.word === null) throw new Unparseable('a word that starts with #');
      wordPart(state);
    }
  }
  endWord(state);
  finish(state);
  return state.segments;
}

function operator(state: State): void {
  const { src, pos } = state;
  const c = src.charAt(pos);
  const next = src.charAt(pos + 1);
  if (c === '(') throw new Unparseable('a subshell');
  if (c === ')') throw new Unparseable('a stray close parenthesis');
  if (c === '<' || c === '>' || (c === '&' && next === '>')) {
    redirect(state);
    return;
  }
  endWord(state);
  if (state.pending !== null) throw new Unparseable('a redirect with no target');
  let joiner: Joiner = '\n';
  let length = 1;
  if (c === '|' && next === '|') [joiner, length] = ['||', 2];
  else if (c === '|') joiner = '|';
  else if (c === '&' && next === '&') [joiner, length] = ['&&', 2];
  else if (c === '&') joiner = '&';
  else if (c === ';') joiner = ';';
  state.pos += length;
  closeSegment(state, joiner);
}

function closeSegment(state: State, joiner: Joiner): void {
  if (state.words.length === 0 && state.redirects.length === 0) throw new Unparseable('an empty command');
  state.segments.push({ words: state.words, redirects: state.redirects, before: state.before });
  state.words = [];
  state.redirects = [];
  state.before = joiner;
}

function finish(state: State): void {
  if (state.pending !== null) throw new Unparseable('a redirect with no target');
  if (state.words.length > 0 || state.redirects.length > 0) {
    state.segments.push({ words: state.words, redirects: state.redirects, before: state.before });
  } else if (state.before === '|' || state.before === '&&' || state.before === '||') {
    throw new Unparseable('an operator with no command after it');
  }
}

function redirect(state: State): void {
  const { src, pos } = state;
  const c = src.charAt(pos);
  const next = src.charAt(pos + 1);
  let op: Redirect['op'];
  if (c === '&') {
    op = src.startsWith('&>>', pos) ? '&>>' : '&>';
  } else if (c === '<') {
    if (next === '<') throw new Unparseable('a heredoc or here-string');
    if (next === '(') throw new Unparseable('a process substitution');
    op = next === '&' ? '<&' : '<';
  } else {
    if (next === '(') throw new Unparseable('a process substitution');
    op = next === '>' ? '>>' : next === '|' ? '>|' : next === '&' ? '>&' : '>';
  }
  // Digits written straight before a `<` or `>` name a file descriptor, not a word.
  let fd: number | undefined;
  if (c !== '&' && state.word !== null && !state.word.quoted && /^\d+$/.test(state.word.text)) {
    fd = Number(state.word.text);
    state.word = null;
  }
  endWord(state);
  if (state.pending !== null) throw new Unparseable('a redirect with no target');
  state.pos += op.length;
  state.pending = fd === undefined ? { op } : { op, fd };
}

function endWord(state: State): void {
  const word = state.word;
  if (word === null) return;
  state.word = null;
  if (word.raw === '{' || word.raw === '}') throw new Unparseable('a brace group');
  const built: Word = {
    text: word.text,
    raw: word.raw,
    quoted: word.quoted,
    unsafe: word.unsafe,
    substitutions: word.substitutions,
  };
  if (state.pending === null) {
    state.words.push(built);
    return;
  }
  const { op, fd } = state.pending;
  state.redirects.push(fd === undefined ? { op, target: built } : { op, fd, target: built });
  state.pending = null;
}

function current(state: State): Builder {
  if (state.word === null) {
    state.word = { text: '', raw: '', quoted: false, unsafe: false, substitutions: [] };
  }
  return state.word;
}

function append(state: State, text: string, raw: string, quoted: boolean, unsafe: boolean): void {
  const word = current(state);
  word.text += text;
  word.raw += raw;
  word.quoted ||= quoted;
  word.unsafe ||= unsafe;
}

function substitution(state: State, raw: string, body: string): void {
  const word = current(state);
  word.text += raw;
  word.raw += raw;
  word.unsafe = true;
  word.substitutions.push(body);
}

function wordPart(state: State): void {
  const { src, pos } = state;
  const c = src.charAt(pos);
  if (c === "'") {
    const close = src.indexOf("'", pos + 1);
    if (close < 0) throw new Unparseable('an unclosed single quote');
    append(state, src.slice(pos + 1, close), src.slice(pos, close + 1), true, false);
    state.pos = close + 1;
  } else if (c === '"') {
    doubleQuoted(state);
  } else if (c === '\\') {
    const next = src.charAt(pos + 1);
    if (next === '') throw new Unparseable('a trailing backslash');
    // A backslash before a newline joins the lines and adds nothing to the word.
    if (next !== '\n') append(state, next, `\\${next}`, true, false);
    state.pos += 2;
  } else if (c === '$' && src.charAt(pos + 1) === '(') {
    if (src.charAt(pos + 2) === '(') throw new Unparseable('an arithmetic expansion');
    const end = substitutionEnd(src, pos + 2);
    substitution(state, src.slice(pos, end), src.slice(pos + 2, end - 1));
    state.pos = end;
  } else if (c === '$') {
    append(state, c, c, false, true);
    state.pos += 1;
  } else if (c === '`') {
    const end = backtickEnd(src, pos + 1);
    substitution(state, src.slice(pos, end), src.slice(pos + 1, end - 1));
    state.pos = end;
  } else {
    append(state, c, c, false, UNSAFE_CHARS.includes(c));
    state.pos += 1;
  }
}

/** Reads a double-quoted run, where `$` and backticks still expand and are recorded. */
function doubleQuoted(state: State): void {
  const { src } = state;
  const start = state.pos;
  const word = current(state);
  word.quoted = true;
  let text = '';
  let i = start + 1;
  for (;;) {
    if (i >= src.length) throw new Unparseable('an unclosed double quote');
    const c = src.charAt(i);
    const next = src.charAt(i + 1);
    if (c === '"') break;
    if (c === '\\' && next !== '' && '$`"\\'.includes(next)) {
      text += next;
      i += 2;
    } else if (c === '\\' && next === '\n') {
      i += 2;
    } else if (c === '$' && next === '(') {
      if (src.charAt(i + 2) === '(') throw new Unparseable('an arithmetic expansion');
      const end = substitutionEnd(src, i + 2);
      word.substitutions.push(src.slice(i + 2, end - 1));
      word.unsafe = true;
      text += src.slice(i, end);
      i = end;
    } else if (c === '`') {
      const end = backtickEnd(src, i + 1);
      word.substitutions.push(src.slice(i + 1, end - 1));
      word.unsafe = true;
      text += src.slice(i, end);
      i = end;
    } else {
      if (c === '$') word.unsafe = true;
      text += c;
      i += 1;
    }
  }
  word.text += text;
  word.raw += src.slice(start, i + 1);
  state.pos = i + 1;
}

/** How many substitutions may nest inside one another. Past it the scan refuses, before the call stack runs out. */
const MAX_NESTING = 64;

/**
 * The index just past the `)` that closes a `$(` whose body starts at `start`. `depth` counts the substitutions
 * around it, so a nest deeper than MAX_NESTING is refused as unparseable rather than overflowing the stack.
 */
function substitutionEnd(src: string, start: number, depth = 0): number {
  if (depth > MAX_NESTING) throw new Unparseable('substitutions nested too deeply');
  let open = 0;
  let i = start;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      if (close < 0) throw new Unparseable('an unclosed single quote');
      i = close + 1;
    } else if (c === '"') {
      i = doubleQuoteEnd(src, i + 1, depth);
    } else if (c === '`') {
      i = backtickEnd(src, i + 1);
    } else if (c === '\\') {
      i += 2;
    } else if (c === '$' && src.charAt(i + 1) === '(') {
      i = substitutionEnd(src, i + 2, depth + 1);
    } else if (c === '(') {
      open += 1;
      i += 1;
    } else if (c === ')') {
      if (open === 0) return i + 1;
      open -= 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  throw new Unparseable('an unclosed substitution');
}

/** The index just past the quote that closes a double-quoted run whose body starts at `start`. */
function doubleQuoteEnd(src: string, start: number, depth: number): number {
  let i = start;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === '"') return i + 1;
    if (c === '\\') i += 2;
    else if (c === '$' && src.charAt(i + 1) === '(') i = substitutionEnd(src, i + 2, depth + 1);
    else if (c === '`') i = backtickEnd(src, i + 1);
    else i += 1;
  }
  throw new Unparseable('an unclosed double quote');
}

/** The index just past the backtick that closes a substitution whose body starts at `start`. */
function backtickEnd(src: string, start: number): number {
  let i = start;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === '`') return i + 1;
    i += c === '\\' ? 2 : 1;
  }
  throw new Unparseable('an unclosed backtick');
}
