// The shell tokenizer: a command string becomes segments of words, or it is refused. It evaluates nothing.

/** The control operators that join one segment to the one before it, or start the script (null). */
export type Joiner = '|' | '&&' | '||' | ';' | '&' | '\n' | null;

/** One word: `text` is the unquoted literal, `unsafe` marks an unquoted `$`, backtick, `~`, `{`, `}`, `*`, `?` or `[`. */
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

/** Splits a command into segments. Throws `Unparseable` for anything it cannot fully parse. */
export function tokenize(_command: string): Script {
  return [];
}
