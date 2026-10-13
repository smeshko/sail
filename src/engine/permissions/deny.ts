// The default deny set: nine rules checked on each normalized command, before any step pattern.
import { basename } from 'node:path';
import { gitSubcommand, leadingCommand, type NormalizedCommand } from './normalize';
import type { Script, Segment, Word } from './tokenize';
import type { Rule } from './types';

/** A deny-set match: its `deny:<name>` rule and a reason naming the command that matched. */
export interface DenyMatch {
  readonly rule: Rule;
  readonly reason: string;
}

interface DenyEntry {
  readonly rule: Rule;
  readonly matches: (argv: readonly string[], pipeline: Script) => boolean;
}

const SHELLS = new Set(['sh', 'bash', 'zsh']);
const RM_LONG_FLAGS = { '--recursive': 'r', '--force': 'f' } as const;
const CLEAN_LONG_FLAGS = { '--force': 'f' } as const;
const BRANCH_LONG_FLAGS = { '--force': 'f' } as const;

/** The letters of a command's flags, with each long form (`--force`) mapped to its letter. Stops at `--`. */
function flagLetters(args: readonly string[], longForms: Readonly<Record<string, string>>): Set<string> {
  const letters = new Set<string>();
  for (const arg of args) {
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      const letter = longForms[arg];
      if (letter !== undefined) letters.add(letter);
    } else if (arg.startsWith('-')) {
      for (const letter of arg.slice(1)) letters.add(letter);
    }
  }
  return letters;
}

function commandName(argv: readonly string[]): string {
  return basename(argv[0] ?? '');
}

/** A git command with the named subcommand whose arguments satisfy `accepts`. */
function gitIs(argv: readonly string[], subcommand: string, accepts: (args: readonly string[]) => boolean): boolean {
  if (commandName(argv) !== 'git') return false;
  const sub = gitSubcommand(argv);
  return sub !== null && sub.name === subcommand && accepts(sub.args);
}

/** Whether a git push argument forces the update: `-f`, a `--force…` form, a `+` refspec, or a short cluster with `f`. */
function forcesPush(arg: string): boolean {
  if (arg.startsWith('+') || arg.startsWith('--force')) return true;
  return arg.startsWith('-') && !arg.startsWith('--') && arg.includes('f');
}

/** Whether a sh, bash or zsh runs as the second command of a pipeline whose first segment is a `curl` call. */
function pipedIntoShell(argv: readonly string[], pipeline: Script): boolean {
  return pipeline.some((segment, index) => endsWithWords(segment.words, argv) && isShellSegment(pipeline[index + 1]));
}

function endsWithWords(words: readonly Word[], argv: readonly string[]): boolean {
  const start = words.length - argv.length;
  return start >= 0 && argv.every((text, offset) => words[start + offset]?.text === text);
}

function isShellSegment(next: Segment | undefined): boolean {
  return next !== undefined && next.before === '|' && SHELLS.has(basename(leadingCommand(next.words)));
}

/** The nine rules, in the order they are checked. */
const DENY_SET: readonly DenyEntry[] = [
  {
    rule: 'deny:rm-rf',
    matches: (argv) => {
      if (commandName(argv) !== 'rm') return false;
      const letters = flagLetters(argv.slice(1), RM_LONG_FLAGS);
      return (letters.has('r') || letters.has('R')) && letters.has('f');
    },
  },
  {
    rule: 'deny:git-push-force',
    matches: (argv) => gitIs(argv, 'push', (args) => args.some(forcesPush)),
  },
  {
    rule: 'deny:git-reset-hard',
    matches: (argv) => gitIs(argv, 'reset', (args) => args.includes('--hard')),
  },
  {
    rule: 'deny:git-clean-f',
    matches: (argv) => gitIs(argv, 'clean', (args) => flagLetters(args, CLEAN_LONG_FLAGS).has('f')),
  },
  {
    rule: 'deny:git-branch-D',
    matches: (argv) =>
      gitIs(argv, 'branch', (args) => {
        const letters = flagLetters(args, BRANCH_LONG_FLAGS);
        return letters.has('D') || (args.includes('--delete') && letters.has('f'));
      }),
  },
  {
    rule: 'deny:git-checkout',
    matches: (argv) => gitIs(argv, 'checkout', () => true),
  },
  {
    rule: 'deny:git-switch',
    matches: (argv) => gitIs(argv, 'switch', () => true),
  },
  {
    rule: 'deny:sudo',
    matches: (argv) => commandName(argv) === 'sudo',
  },
  {
    rule: 'deny:curl-pipe-shell',
    matches: (argv, pipeline) => commandName(argv) === 'curl' && pipedIntoShell(argv, pipeline),
  },
];

/** The deny rule a normalized command matches, given its pipeline, or null. */
export function denyRule(command: NormalizedCommand, pipeline: Script): DenyMatch | null {
  const entry = DENY_SET.find((candidate) => candidate.matches(command.argv, pipeline));
  if (entry === undefined) return null;
  return {
    rule: entry.rule,
    reason: `\`${command.argv.join(' ')}\` is in the default deny set, which a step's commands cannot allow`,
  };
}
