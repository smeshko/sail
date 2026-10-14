// A shell parser for the permission engine: it turns a command string into every simple command a shell would run for
// it, nested ones included, and refuses, with a reason, any construct outside the closed list it understands (D7).
// It parses and never expands: a word keeps its `$VAR` and its substitutions as written.
// STUB (tdd-plan): every command is refused. TASK-004 writes the parser.

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
  return { ok: false, reason: `stub: ${text.length}` };
}
