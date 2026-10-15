// What a Bash command does that decide() can't see, refused before decide() is asked. decide() reads every command as
// bash, and the CLI runs the Bash tool under bash (D4 and review R1-1), but a command can start another shell, which
// reads some commands otherwise (zsh's `>!` writes its next word; dash's `&>` sends a job to the background). A job
// sent to the background outlives its call, out of the session's process group (D8). And git diff's `--no-index`
// compares any two files, which no read rule checks; an operand outside the worktree turns it on by itself.
//
// The command is read as the parser reads it, its substitutions included, and every quoted or escaped word that could
// hold commands of its own (a `-c` text, an `eval`'s arguments) is read again, unquoted, as a command, at any depth.
// Each reading is shorter than the one before, so it ends. That reads some plain arguments as commands too, which
// refuses more than it must: it fails closed.
import { basename } from 'node:path';
import { MAX_DEPTH, type Pipeline, parseCommand, type Word } from '../../engine/permissions/shell';

/** Why a command sending a job to the background is refused. */
export const BACKGROUND = 'a command run in the background with & can outlive the session';

/** The shells other than bash, by the base name of the word that runs one. */
const OTHER_SHELLS = /^(?:sh|zsh|ksh|ksh93|mksh|pdksh|dash|ash|yash|posh|fish|csh|tcsh|busybox)(?:-?[\d.]+)?$/;

/** A word that may hold commands of its own: one with a blank or a shell metacharacter in it once unquoted. */
const MAY_HOLD_COMMANDS = /[\s;&|<>()`$]/;

/** Why `command` can't run, or undefined. A command that doesn't parse is decide()'s to refuse. */
export function refusedCommand(command: string): string | undefined {
  const parsed = parseCommand(command);
  return parsed.ok ? inList(parsed.list, 0) : undefined;
}

function inList(list: readonly Pipeline[], depth: number): string | undefined {
  if (depth > MAX_DEPTH) return `commands nested deeper than ${MAX_DEPTH} levels`;
  for (const pipeline of list) {
    if (pipeline.background) return BACKGROUND;
    for (const command of pipeline.commands) {
      const words = [
        ...command.assignments.map((assignment) => assignment.value),
        ...command.words,
        ...command.redirections.flatMap((redirection) =>
          redirection.target === undefined ? [] : [redirection.target],
        ),
      ];
      const nested = command.redirections.flatMap((redirection) => redirection.heredoc?.nested ?? []);
      const found =
        firstOf(words, (word) => inWord(word, depth)) ??
        outsideDiffOperand(command.words) ??
        firstOf(nested, (inner) => inList(inner, depth + 1));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function inWord(word: Word, depth: number): string | undefined {
  if (OTHER_SHELLS.test(basename(word.text))) {
    return `${word.text} reads some commands otherwise than bash, which they are checked as: run them under bash`;
  }
  if (word.text.startsWith('--no-in')) return "git diff's --no-index reads files no read rule checks";
  const found = firstOf(word.nested, (inner) => inList(inner, depth + 1));
  // A word the shell sees as written holds no commands but its substitutions, just read.
  if (found !== undefined || word.text === word.raw || !MAY_HOLD_COMMANDS.test(word.text)) return found;
  const parsed = parseCommand(word.text);
  return parsed.ok ? inList(parsed.list, depth + 1) : undefined;
}

/**
 * A `git diff` operand that may lie outside the worktree, which turns `--no-index` on by itself: one that is absolute,
 * climbs with `..`, starts with `~`, is find's `{}`, or isn't known before it runs.
 */
function outsideDiffOperand(words: readonly Word[]): string | undefined {
  const git = words.findIndex((word) => word.literal && basename(word.text) === 'git');
  const diff = words.findIndex((word, i) => git !== -1 && i > git && word.literal && word.text === 'diff');
  if (diff === -1) return undefined;
  const outside = words.slice(diff + 1).find((word) => {
    if (word.literal && word.text.startsWith('-')) return false;
    const { text } = word;
    return !word.literal || /^[/~]/.test(text) || text.split('/').includes('..') || text.includes('{}');
  });
  if (outside === undefined) return undefined;
  return `git diff of ${outside.raw}: an operand outside the worktree turns on --no-index, which reads files no read rule checks; name revisions, and paths inside the worktree as written`;
}

function firstOf<T>(items: readonly T[], check: (item: T) => string | undefined): string | undefined {
  for (const item of items) {
    const found = check(item);
    if (found !== undefined) return found;
  }
  return undefined;
}
