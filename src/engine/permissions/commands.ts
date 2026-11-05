// The decision for a command: every simple command it would run, found through wrappers, nested shells and
// substitutions (D9), checked against the deny set first, then the step's commands, then where `cd`, git's directory
// options and every redirection lead. A name the command sets earlier shadows the environment for its later words, and a
// `cd` sets `PWD` and `OLDPWD` for the words after it.
import { statSync } from 'node:fs';
import {
  commandName,
  type DenyEntry,
  denied,
  deniedAssignment,
  deniedPipeline,
  gitInvocation,
  optionValues,
} from './deny';
import { matchesCommand } from './glob';
import { checkRead, checkWrite, expand, insideRoots, logical, resolvePhysical } from './paths';
import {
  bodies,
  type Command,
  type Compound,
  MAX_DEPTH,
  type Pipeline,
  parseCommand,
  type Redirection,
  type Word,
} from './shell';
import { allow, type DecideContext, type Decision, deny, type Permissions } from './types';

/** Where a command runs: the directory `cd` reports, and the one the kernel resolves paths from. */
interface Cwd {
  readonly logical: string;
  readonly physical: string;
}

/** One command the shell would run. */
interface Run {
  /** Its argv, with the variables the preamble holds expanded: what the deny set sees. */
  readonly argv: readonly string[];
  /** An argument the shell turns into something not seen here: a substitution, a glob, an unknown variable. */
  readonly open: boolean;
  /** Its words joined by spaces, as written: what a command pattern is matched against (D8). */
  readonly match: string;
  /** The command as the agent wrote it, for reasons. */
  readonly text: string;
}

interface Target {
  /** Where it leads, resolved when it was collected, or undefined when that can't be known here. */
  readonly path: string | undefined;
  /** The target as written. */
  readonly raw: string;
  readonly text: string;
  readonly cwd: string;
}

interface Collected {
  readonly runs: Run[];
  readonly pipelines: string[][][];
  readonly assignments: { readonly name: string; readonly text: string }[];
  readonly refusals: string[];
  readonly problems: string[];
  readonly reads: Target[];
  readonly writes: Target[];
}

/** What an argument the shell expands at run time could add: the flags the deny set looks for. */
const WORST = ['-rf', '--force', '--hard', '-D', '-delete'];
/** A `for` loop's list is walked word by word only up to this many words, and every walk spends from the budget. */
const LOOP_WORDS = 16;
const LOOP_WALKS = 64;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const VALUE_LETTERS: Record<string, string> = { sh: 'o', dash: 'o', zsh: 'o', bash: 'oO', ksh: 'oR' };
const DECLARERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);
/** Builtins that assign the names among their arguments, other than by `NAME=value`. */
const ASSIGNERS = new Set(['read', 'mapfile', 'readarray', 'getopts', 'printf', 'let', 'unset', ...DECLARERS]);
/** The names a builtin sets without being given them. */
const SET_BY_DEFAULT: Record<string, string[]> = {
  read: ['REPLY'],
  mapfile: ['MAPFILE'],
  readarray: ['MAPFILE'],
  getopts: ['OPTARG', 'OPTIND'],
};
const GIT_PATHS = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']);
const OUTPUT = /^--o(?:u(?:t(?:p(?:u(?:t)?)?)?)?)?(?:=|$)/;

/** Git options whose values are shell commands, rather than program names. */
const GIT_COMMANDS: Record<string, { long: string[]; short?: string }> = {
  rebase: { long: ['--exec'], short: 'x' },
  difftool: { long: ['--extcmd'], short: 'x' },
  'filter-branch': {
    long: [
      '--setup',
      '--env-filter',
      '--tree-filter',
      '--index-filter',
      '--parent-filter',
      '--msg-filter',
      '--commit-filter',
      '--tag-name-filter',
    ],
  },
  'send-email': { long: ['--sendmail-cmd', '--to-cmd', '--cc-cmd', '--header-cmd'] },
};

interface Grammar {
  /** Options that take no value. */
  readonly flags: readonly string[];
  /** Options that take a value, attached (`-n1`, `--max-args=1`) or as the next word. */
  readonly valued: readonly string[];
  /** Long options whose value attaches only with `=`. */
  readonly optional?: readonly string[];
  /** Valued options that name a file the wrapper writes. */
  readonly writes?: readonly string[];
  /** Options of the form `-<digits>`. */
  readonly numeric?: boolean;
  /** Words to skip after the options, such as `timeout`'s duration. */
  readonly positional?: number;
}

/** The wrappers, each by its option grammar: what follows is the command they run. */
const WRAPPERS: Readonly<Record<string, Grammar>> = {
  env: { flags: ['-i', '--ignore-environment', '-0', '--null', '-'], valued: ['-u', '--unset'] },
  command: { flags: ['-p'], valued: [] },
  exec: { flags: ['-c', '-l'], valued: ['-a'] },
  nice: { flags: [], valued: ['-n', '--adjustment'], numeric: true },
  nohup: { flags: [], valued: [] },
  time: { flags: ['-p', '-l', '-h', '-a', '--append'], valued: ['-o', '--output'], writes: ['-o', '--output'] },
  timeout: {
    flags: ['--preserve-status', '--foreground', '-v', '--verbose'],
    valued: ['-s', '--signal', '-k', '--kill-after'],
    positional: 1,
  },
  xargs: {
    flags: ['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-p', '--interactive', '-x', '--exit', '-o'],
    valued: ['-n', '--max-args', '-L', '-P', '--max-procs', '-I', '-d', '--delimiter'],
    optional: ['--replace', '--max-lines'],
  },
};

function quote(text: string): string {
  return `\`${text.length > 200 ? `${text.slice(0, 200)}…` : text}\``;
}

/** Where the options of `grammar` end in `args`, or the option it doesn't know. */
function skipOptions(args: readonly Word[], grammar: Grammar): { at: number; writes: Word[] } | { unknown: string } {
  const writes: Word[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = (args[i] as Word).text;
    if (arg === '--') return { at: i + 1, writes };
    if (!arg.startsWith('-') || (arg === '-' && !grammar.flags.includes('-'))) break;
    const name = arg.startsWith('--') ? (arg.split('=')[0] as string) : arg;
    const writeOption = grammar.writes?.find((option) =>
      option.startsWith('--') ? option === name : arg.startsWith(option),
    );
    if (writeOption !== undefined) {
      const attached = arg.slice(writeOption.length).replace(/^=/, '');
      const value = arg === writeOption ? args[i + 1] : { ...(args[i] as Word), text: attached };
      if (value !== undefined) writes.push(value);
    }
    if (grammar.optional?.includes(name)) i++;
    else if (grammar.flags.includes(arg)) i++;
    else if (grammar.valued.includes(name) && name !== arg) i++;
    else if (grammar.valued.includes(arg)) i += 2;
    else if (!arg.startsWith('--') && arg.length > 2 && grammar.valued.includes(arg.slice(0, 2))) i++;
    else if (grammar.numeric === true && /^-\d+$/.test(arg)) i++;
    else return { unknown: arg };
  }
  return { at: Math.min(i + (grammar.positional ?? 0), args.length), writes };
}

/** The names a builtin among `name` and `args` sets: every argument that starts like a name, and its defaults. */
function setNames(name: string, args: readonly Word[]): string[] {
  const names = [...(SET_BY_DEFAULT[name] ?? [])];
  for (const arg of args) {
    const assigned = /^[A-Za-z_][A-Za-z0-9_]*/.exec(arg.text);
    if (assigned !== null) names.push(assigned[0]);
  }
  return names;
}

/** Every name a static scan finds `lists` set, inside compound bodies and `eval` text too, but not in substitutions. */
function assignedIn(lists: readonly (readonly Pipeline[])[]): Set<string> {
  const names = new Set<string>();
  const scan = (list: readonly Pipeline[]): void => {
    for (const pipeline of list) for (const command of pipeline.commands) visit(command);
  };
  const visit = (command: Command): void => {
    if (command.kind !== 'simple') {
      if (command.kind === 'for') names.add(command.name);
      for (const body of bodies(command)) scan(body);
      return;
    }
    for (const assignment of command.assignments) names.add(assignment.name);
    const at = command.words.findIndex((word) => ASSIGNERS.has(commandName(word.text)) || word.text === 'eval');
    if (at === -1) return;
    const rest = command.words.slice(at + 1);
    const head = commandName((command.words[at] as Word).text);
    if (head === 'eval') {
      const parsed = parseCommand(rest.map((word) => word.text).join(' '));
      if (parsed.ok) scan(parsed.list);
    } else for (const name of setNames(head, rest)) names.add(name);
  };
  for (const list of lists) scan(list);
  return names;
}

class Collector {
  readonly out: Collected = {
    runs: [],
    pipelines: [],
    assignments: [],
    refusals: [],
    problems: [],
    reads: [],
    writes: [],
  };

  /** Loop variables in scope: a name bound to a value, or to undefined when the shell's value isn't known here. */
  private readonly bound = new Map<string, string | undefined>();
  /** Loop variables a command assigns: the walk is repeated with each never bound, since bash uses the new value. */
  readonly reassigned = new Set<string>();
  /** Loop variables whose body is being walked: an assignment to one never binds a value. */
  private readonly looping = new Set<string>();
  private walks = 0;

  constructor(
    private readonly ctx: DecideContext,
    private readonly unbindable: ReadonlySet<string> = new Set(),
  ) {}

  /** A command assigns `name`: a loop variable of that name no longer holds its word. */
  private assigned(name: string): void {
    if (this.looping.has(name) && this.bound.get(name) !== undefined) this.reassigned.add(name);
    this.bound.set(name, undefined);
  }

  private unbind(names: Iterable<string>): void {
    for (const name of names) this.assigned(name);
  }

  private value(name: string): string | undefined {
    return this.bound.has(name) ? this.bound.get(name) : this.ctx.env[name];
  }

  /** The value a word has when the shell runs it, if that can be known here. */
  known(word: Word): string | undefined {
    if (word.literal) return word.text;
    if (word.nested.length > 0 || word.glob || /['\\]/.test(word.raw)) return undefined;
    if (word.vars.some((name) => this.value(name) === undefined)) return undefined;
    const env: Record<string, string> = { ...this.ctx.env };
    for (const [name, value] of this.bound) if (value !== undefined) env[name] = value;
    const expanded = expand(word.text, env);
    if (!expanded.ok || /[\s*?[]/.test(expanded.path)) return undefined;
    return expanded.path;
  }

  /** Runs `fn`, then puts `PWD` and `OLDPWD` back as they were: the contexts that discard a cwd discard these too. */
  private scoped(fn: () => void): void {
    const names = ['PWD', 'OLDPWD'];
    const before = names.map((name) => [name, this.bound.has(name), this.bound.get(name)] as const);
    fn();
    for (const [name, had, value] of before) {
      if (had) this.bound.set(name, value);
      else this.bound.delete(name);
    }
  }

  /** Collects `list` run from `cwd`; returns where its commands leave the working directory. */
  list(list: readonly Pipeline[], cwd: Cwd, depth: number, inBody = false, sure = true): Cwd {
    if (depth > MAX_DEPTH) {
      this.out.refusals.push(`commands nested deeper than ${MAX_DEPTH} levels`);
      return cwd;
    }
    let here = cwd;
    for (const pipeline of list) {
      const argvs: string[][] = [];
      const surely = sure && pipeline.commands.length === 1 && !pipeline.background && !pipeline.conditional;
      let moved: Cwd | undefined;
      const walk = () => {
        for (const command of pipeline.commands) {
          if (command.kind === 'simple') argvs.push(command.words.map((word) => this.known(word) ?? word.text));
          else if (pipeline.commands.length > 1) argvs.push(...this.flat(command));
          moved = this.command(command, here, depth, inBody, surely);
        }
      };
      if (pipeline.commands.length > 1 || pipeline.background) this.scoped(walk);
      else walk();
      if (argvs.length > 0) this.out.pipelines.push(argvs);
      if (moved === undefined || pipeline.commands.length !== 1 || pipeline.background) continue;
      if (inBody) {
        const text = (pipeline.commands[0] as Command).text;
        this.out.refusals.push(
          `a cd inside a loop or branch body: ${quote(text)}; put it before the construct, or inside ( … )`,
        );
      } else {
        here = moved;
        if ((pipeline.commands[0] as Command).kind === 'simple') {
          this.bound.set('OLDPWD', this.value('PWD'));
          this.bound.set('PWD', moved.logical);
        }
      }
    }
    return here;
  }

  /**
   * Walks a `for` loop's body once per word of a literal list, with the name bound to that word, or once with the name
   * unknown when the list isn't literal, is longer than LOOP_WORDS, or would overspend the command's LOOP_WALKS. The
   * name is left unknown afterwards: bash leaves it at the last word, and unknown is the cautious choice.
   */
  private loop(name: string, list: readonly Word[] | undefined, walk: () => void): void {
    const values = list?.map((word) => this.known(word));
    const literal =
      values !== undefined && values.length > 0 && values.length <= LOOP_WORDS && !this.unbindable.has(name);
    if (literal && values.every((value) => value !== undefined) && this.walks + values.length <= LOOP_WALKS) {
      this.walks += values.length;
      this.looping.add(name);
      for (const value of values) {
        this.bound.set(name, value);
        walk();
      }
    } else {
      this.looping.add(name);
      this.bound.set(name, undefined);
      walk();
    }
    this.looping.delete(name);
    this.bound.set(name, undefined);
  }

  /** The argv of every simple command a compound command holds, for the pipeline checks. */
  private flat(command: Command): string[][] {
    if (command.kind === 'simple') return [command.words.map((word) => this.known(word) ?? word.text)];
    return bodies(command).flatMap((body) =>
      body.flatMap((pipeline) => pipeline.commands.flatMap((c) => this.flat(c))),
    );
  }

  private nested(words: readonly (Word | undefined)[], cwd: Cwd, depth: number): void {
    for (const word of words) for (const list of word?.nested ?? []) this.subshell(list, cwd, depth + 1);
  }

  /** A list run in a shell of its own: its names are unknown once it ends. */
  private subshell(list: readonly Pipeline[], cwd: Cwd, depth: number): void {
    this.scoped(() => this.list(list, cwd, depth));
    this.unbind(assignedIn([list]));
  }

  /** Collects one command; returns where it moves the working directory, if it does. */
  private command(command: Command, cwd: Cwd, depth: number, inBody: boolean, surely: boolean): Cwd | undefined {
    if (command.kind !== 'simple') return this.compound(command, cwd, depth, inBody, surely);
    this.nested([...command.assignments.map((a) => a.value), ...command.words], cwd, depth);
    const bare = command.words.length === 0;
    // With no command name, bash makes the assignments before the redirections.
    if (!bare) this.redirections(command.redirections, command.text, cwd, depth);
    for (const assignment of command.assignments) {
      this.assign(assignment.name, assignment.value, command.text, cwd);
      if (bare && surely && !this.looping.has(assignment.name) && assignment.append !== true) {
        this.bound.set(assignment.name, this.known(assignment.value));
      } else this.unbind([assignment.name]);
    }
    if (bare) {
      this.redirections(command.redirections, command.text, cwd, depth);
      return undefined;
    }
    const moved = this.unwrap(command.words, command.text, cwd, depth, false);
    this.unbind(command.assignments.map((assignment) => assignment.name));
    if (!surely) this.unbind(assignedIn([[{ commands: [command], background: false, conditional: false }]]));
    return moved;
  }

  /** The substitutions, heredocs and targets of redirections, whether on a simple or a compound command. */
  private redirections(list: readonly Redirection[], text: string, cwd: Cwd, depth: number): void {
    this.nested(
      list.map((redirection) => redirection.target),
      cwd,
      depth,
    );
    for (const redirection of list) {
      for (const inner of redirection.heredoc?.nested ?? []) this.subshell(inner, cwd, depth + 1);
      const target = redirection.target;
      if (target === undefined || redirection.op === '<<<') continue;
      const into = redirection.op === '<' ? this.out.reads : this.out.writes;
      into.push(this.target(target, text, cwd.physical));
    }
  }

  private target(word: Word | string, text: string, cwd: string): Target {
    if (typeof word === 'string') return { path: word, raw: word, text, cwd };
    return { path: this.known(word), raw: word.raw, text, cwd };
  }

  private compound(command: Compound, cwd: Cwd, depth: number, inBody: boolean, surely: boolean): Cwd | undefined {
    const moved = this.compoundBody(command, cwd, depth, inBody, surely);
    if (command.kind !== 'group' || !surely) this.unbind(assignedIn(bodies(command)));
    return moved;
  }

  private compoundBody(command: Compound, cwd: Cwd, depth: number, inBody: boolean, surely: boolean): Cwd | undefined {
    this.redirections(command.redirections, command.text, cwd, depth);
    const body = (list: readonly Pipeline[], branch: boolean, sure = true) =>
      this.list(list, cwd, depth + 1, branch, sure);
    const arm = (list: readonly Pipeline[]) => {
      body(list, true);
      this.unbind(assignedIn([list]));
    };
    switch (command.kind) {
      case 'group': {
        const end = body(command.body, inBody, surely);
        return end === cwd ? undefined : end;
      }
      case 'subshell':
        this.scoped(() => body(command.body, false));
        return undefined;
      case 'for':
        this.out.assignments.push({ name: command.name, text: command.text });
        this.nested(command.words ?? [], cwd, depth);
        this.unbind(assignedIn(bodies(command)));
        this.loop(command.name, command.words, () => body(command.body, true));
        return undefined;
      case 'while':
      case 'until':
        this.unbind(assignedIn(bodies(command)));
        body(command.condition, true);
        body(command.body, true);
        return undefined;
      case 'if':
        for (const clause of command.clauses) {
          body(clause.condition, true);
          arm(clause.body);
        }
        if (command.otherwise !== undefined) arm(command.otherwise);
        return undefined;
      case 'case':
        this.nested([command.word, ...command.arms.flatMap((arm) => arm.patterns)], cwd, depth);
        for (const each of command.arms) arm(each.body);
        return undefined;
    }
  }

  private assign(name: string, value: Word, text: string, cwd: Cwd): void {
    this.out.assignments.push({ name, text });
    if (GIT_PATHS.has(name)) this.inside(value, `${name}=${value.raw}`, cwd.physical);
  }

  /** Records a problem unless `word` resolves inside the roots; returns where it resolves. */
  private inside(word: Word | string, said: string, cwd: string): string | undefined {
    const path = typeof word === 'string' ? word : this.known(word);
    if (path === undefined || path.includes('$') || path.startsWith('~')) {
      this.out.problems.push(`${said}: the path can't be resolved before it runs`);
      return undefined;
    }
    const found = insideRoots(path, this.ctx, cwd);
    if (!found.ok) {
      this.out.problems.push(`${said}: ${found.reason}`);
      return undefined;
    }
    return found.path;
  }

  private unwrap(words: readonly Word[], text: string, cwd: Cwd, depth: number, fed: boolean): Cwd | undefined {
    const head = words[0] as Word;
    if (!head.literal || head.text === '' || /\s/.test(head.text)) {
      this.out.refusals.push(`the command name ${head.raw} isn't a literal name: ${quote(text)}`);
      return undefined;
    }
    const name = commandName(head.text);
    const args = words.slice(1);
    if (name === 'cd') return this.cd(args, text, cwd);
    const grammar = WRAPPERS[name];
    const looksUp = name === 'command' && ['-v', '-V'].includes(args[0]?.text ?? '');
    if (grammar !== undefined && !looksUp) {
      const skipped = skipOptions(args, grammar);
      if ('unknown' in skipped) {
        this.out.refusals.push(`${name}'s option ${skipped.unknown} isn't known: ${quote(text)}`);
        return undefined;
      }
      for (const word of skipped.writes) this.out.writes.push(this.target(word, text, cwd.physical));
      let at = skipped.at;
      if (name === 'env') {
        for (; at < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test((args[at] as Word).text); at++) {
          const word = args[at] as Word;
          const eq = word.text.indexOf('=');
          this.assign(word.text.slice(0, eq), { ...word, text: word.text.slice(eq + 1) }, text, cwd);
        }
      }
      const inner = args.slice(at);
      if (inner.length > 0) {
        this.unwrap(inner, inner.map((word) => word.text).join(' '), cwd, depth, fed || name === 'xargs');
        return undefined;
      }
    }
    if (SHELLS.has(name) && this.shell(name, args, text, cwd, depth)) return undefined;
    if (name === 'eval') {
      this.eval(args, text, cwd, depth);
      return undefined;
    }
    const argv = words.map((word) => this.known(word) ?? word.text);
    const open = fed || words.some((word) => this.known(word) === undefined);
    this.out.runs.push({ argv, open, match: words.map((word) => word.text).join(' '), text });
    if (DECLARERS.has(name)) {
      const nameref = args.find((arg) => /^-[A-Za-z]*n/.test(arg.text));
      if (name !== 'export' && nameref !== undefined) {
        this.out.refusals.push(
          `a nameref, ${name} ${nameref.text}, which sets one name through another: ${quote(text)}`,
        );
      }
      for (const arg of args) {
        const assigned = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(arg.text);
        if (assigned !== null) this.out.assignments.push({ name: assigned[1] as string, text });
      }
    }
    if (ASSIGNERS.has(name)) this.unbind(setNames(name, args));
    if (name === 'find') this.find(args, text, cwd, depth);
    if (name === 'git') this.git(argv, fed ? undefined : words, open, text, cwd, depth);
    return undefined;
  }

  private cd(args: readonly Word[], text: string, cwd: Cwd): Cwd | undefined {
    let physical = false;
    let i = 0;
    for (; i < args.length && /^-[LPe@]+$/.test((args[i] as Word).text); i++) {
      if ((args[i] as Word).text.includes('P')) physical = true;
    }
    const rest = args.slice(i);
    const said = `cd in ${quote(text)}`;
    if (rest.length === 0) {
      this.out.problems.push(`${said}: cd with no directory goes to $HOME, outside the workspace`);
      return undefined;
    }
    if (rest.length > 1 || (rest[0] as Word).text === '-') {
      this.out.problems.push(`${said}: where it leads can't be known before it runs`);
      return undefined;
    }
    const target = this.known(rest[0] as Word);
    if (target === undefined || target.startsWith('~')) {
      this.out.problems.push(`${said}: the directory can't be resolved before it runs`);
      return undefined;
    }
    const lexical = physical ? undefined : logical(target, cwd.logical);
    const resolved = resolvePhysical(lexical ?? target, cwd.physical);
    if (!resolved.ok) {
      this.out.problems.push(`${said}: ${resolved.reason}`);
      return undefined;
    }
    const found = this.inside(resolved.path, said, cwd.physical);
    if (found === undefined) return undefined;
    let directory = false;
    try {
      directory = statSync(found).isDirectory();
    } catch {}
    if (!directory) {
      this.out.problems.push(`${said}: ${found} is not a directory`);
      return undefined;
    }
    return { logical: lexical ?? found, physical: found };
  }

  /** Consume option values before finding `-c` text or a script; shells reading their input are refused. */
  private shell(name: string, args: readonly Word[], text: string, cwd: Cwd, depth: number): boolean {
    let command = false;
    let input = false;
    let i = 0;
    for (; i < args.length; i++) {
      const arg = (args[i] as Word).text;
      if (arg === '--' || arg === '-') {
        i++;
        break;
      }
      if (arg === '--emulate' && name === 'zsh') i++;
      else if (arg === '--rcfile' || arg === '--init-file') {
        this.out.refusals.push(`${name} ${arg} runs a file of commands: ${quote(text)}`);
        return true;
      } else if (arg.startsWith('--')) continue;
      else if (/^[-+][A-Za-z]+$/.test(arg)) {
        if (arg.startsWith('-') && arg.includes('c')) command = true;
        if (arg.includes('s')) input = true;
        i += [...arg.slice(1)].filter((letter) => VALUE_LETTERS[name]?.includes(letter)).length;
      } else break;
    }
    if (command) {
      const body = args[i];
      if (body === undefined || !body.literal) {
        this.out.refusals.push(`${name} -c with text that isn't literal: ${quote(text)}`);
        return true;
      }
      this.parse(body.text, `${name} -c`, cwd, depth, true);
      return true;
    }
    if (input || i >= args.length) {
      this.out.refusals.push(`${name} reading commands from its input: ${quote(text)}`);
      return true;
    }
    return false;
  }

  private eval(args: readonly Word[], text: string, cwd: Cwd, depth: number): void {
    if (args.some((arg) => !arg.literal)) {
      this.out.refusals.push(`eval of text that isn't literal: ${quote(text)}`);
      return;
    }
    this.parse(args.map((arg) => arg.text).join(' '), 'eval', cwd, depth, false);
  }

  /** A new shell (`fresh`) sees only the names the environment exports, and leaves none of its own behind. */
  private parse(body: string, by: string, cwd: Cwd, depth: number, fresh: boolean): void {
    const parsed = parseCommand(body);
    if (!parsed.ok) {
      this.out.refusals.push(`${by}: ${parsed.reason}`);
      return;
    }
    if (!fresh) {
      this.scoped(() => this.list(parsed.list, cwd, depth + 1));
      return;
    }
    const outer = new Map(this.bound);
    for (const name of outer.keys()) if (!(name in this.ctx.env)) this.bound.set(name, undefined);
    this.list(parsed.list, cwd, depth + 1);
    this.bound.clear();
    for (const [name, value] of outer) this.bound.set(name, value);
  }

  /** `find`'s `-exec` and its kin run a command per file: each is collected. */
  private find(args: readonly Word[], text: string, cwd: Cwd, depth: number): void {
    for (let i = 0; i < args.length; i++) {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes((args[i] as Word).text)) continue;
      const end = args.findIndex((arg, j) => j > i && (arg.text === ';' || arg.text === '+'));
      if (end === -1 || end === i + 1) {
        this.out.refusals.push(`find ${(args[i] as Word).text} without its command and ; or +: ${quote(text)}`);
        return;
      }
      const inner = args.slice(i + 1, end);
      this.unwrap(inner, inner.map((word) => word.text).join(' '), cwd, depth, false);
      i = end;
    }
  }

  /**
   * Whether every argument the shell expands in a git command comes after a literal subcommand and can't become an
   * option: a glob whose first character is a literal other than `-`, which expands only into names starting with it,
   * or the message after `git commit -m`, which git reads as the message, and among whose words, split, no commit
   * option names a command or a file to write.
   */
  private harmlessExpansions(words: readonly Word[] | undefined, at: number, subcommand: string | undefined): boolean {
    if (words === undefined || subcommand === undefined) return false;
    return words.every((word, i) => {
      if (this.known(word) !== undefined) return true;
      if (i <= at) return false;
      const first = word.raw[0] ?? '-';
      if (word.glob && word.vars.length === 0 && word.nested.length === 0) return !'-*?[~{\\'.includes(first);
      const previous = words[i - 1];
      return subcommand === 'commit' && previous !== undefined && ['-m', '--message'].includes(previous.raw);
    });
  }

  /** Confine git's paths, record `--output` writes, and collect commands its options and subcommands run. */
  private git(
    argv: readonly string[],
    words: readonly Word[] | undefined,
    open: boolean,
    text: string,
    cwd: Cwd,
    depth: number,
  ): void {
    const invocation = gitInvocation(argv);
    if (invocation.unknown !== undefined) {
      this.out.refusals.push(`git's option ${invocation.unknown} isn't known: ${quote(text)}`);
      return;
    }
    if (open && !this.harmlessExpansions(words, argv.length - invocation.args.length - 1, invocation.subcommand)) {
      this.out.refusals.push(
        `git's arguments hold an expansion, which could name another subcommand or --output: ${quote(text)}`,
      );
      return;
    }
    let here = cwd.physical;
    for (const global of invocation.globals) {
      if (global.value === undefined || !['-C', '--git-dir', '--work-tree'].includes(global.name)) continue;
      const found = this.inside(global.value, `git ${global.name} ${global.value} in ${quote(text)}`, here);
      if (found !== undefined && global.name === '-C') here = found;
    }
    invocation.args.forEach((arg, i) => {
      if (!OUTPUT.test(arg)) return;
      const eq = arg.indexOf('=');
      const path = eq === -1 ? invocation.args[i + 1] : arg.slice(eq + 1);
      if (path === undefined) this.out.refusals.push(`git ${arg} without its file: ${quote(text)}`);
      else this.out.writes.push(this.target(path, text, here));
    });
    const { subcommand, args } = invocation;
    const from = { logical: here, physical: here };
    const grammar = GIT_COMMANDS[subcommand ?? ''];
    if (grammar !== undefined) {
      for (const { option, value } of optionValues(args, grammar.long, grammar.short)) {
        if (value === undefined || value.trim() === '') {
          this.out.refusals.push(`git ${subcommand} ${option} without its command`);
        } else this.parse(value, `git ${subcommand} ${option}`, from, depth, true);
      }
    }
    let at: number | undefined;
    if (subcommand === 'bisect' && args[0] === 'run') at = 1;
    if (subcommand === 'submodule') {
      let i = 0;
      while (args[i]?.startsWith('-')) i++;
      if (args[i] === 'foreach') {
        i++;
        while (['--recursive', '-q', '--quiet'].includes(args[i] ?? '')) i++;
        at = i;
      }
    }
    if (at === undefined) return;
    const inner = words?.slice(argv.length - args.length + at) ?? [];
    if (inner.length === 0) {
      this.out.refusals.push(`git ${subcommand} without its command`);
    } else if (subcommand === 'submodule' && inner.length === 1) {
      const body = this.known(inner[0] as Word);
      if (body === undefined || body.trim() === '') {
        this.out.refusals.push('git submodule foreach without a resolvable command');
      } else this.parse(body, 'git submodule foreach', from, depth, true);
    } else if (
      subcommand === 'submodule' &&
      // Git's use_shell runs argv[0] as shell text when it contains a metacharacter,
      // appending the remaining arguments as "$@". That is not a plain argv.
      /[|&;<>()$`\\"' \t\n*?[#~=%]/.test(this.known(inner[0] as Word) ?? ' ')
    ) {
      this.out.refusals.push('git submodule foreach with shell text and extra arguments');
    } else {
      this.unwrap(inner, inner.map((word) => word.text).join(' '), from, depth, false);
    }
  }
}

function denial(entry: DenyEntry, text: string): Decision {
  return deny('commands', `default deny: ${entry.name} — ${entry.why}: ${quote(text)}`);
}

function checkTargets(
  targets: readonly Target[],
  check: typeof checkRead,
  rule: 'read' | 'write',
  permissions: Permissions,
  ctx: DecideContext,
): Decision {
  for (const target of targets) {
    const { path, raw } = target;
    if (path === undefined || path.includes('$') || path.startsWith('~')) {
      return deny(rule, `${rule} ${raw} in ${quote(target.text)}: the path can't be resolved before it runs`);
    }
    const decision = check([path], permissions, ctx, target.cwd);
    if (!decision.allow) return deny(rule, `${decision.reason}, in ${quote(target.text)}`);
  }
  return allow;
}

/**
 * The verdict for `command`, run from `cwd` (the worktree when absent): the deny set over every command it would
 * run, then what can't be checked, then the step's denied commands and its commands over each, then `cd` and git's paths, then every
 * redirection's target.
 */
export function decideCommand(command: string, permissions: Permissions, ctx: DecideContext, cwd?: string): Decision {
  if (command.trim() === '') return deny('commands', "can't be checked: an empty command");
  const parsed = parseCommand(command);
  if (!parsed.ok) return deny('commands', `can't be checked: ${parsed.reason}, in ${quote(command)}`);
  const start = cwd ?? ctx.worktree;
  const from = insideRoots(start, ctx);
  if (!from.ok) return deny('commands', `the working directory of ${quote(command)}: ${from.reason}`);

  let collector = new Collector(ctx);
  collector.list(parsed.list, { logical: start, physical: from.path }, 0);
  for (const unbindable = new Set<string>(); [...collector.reassigned].some((name) => !unbindable.has(name)); ) {
    for (const name of collector.reassigned) unbindable.add(name);
    collector = new Collector(ctx, unbindable);
    collector.list(parsed.list, { logical: start, physical: from.path }, 0);
  }
  const out = collector.out;

  for (const run of out.runs) {
    const entry = denied(run.open ? [...run.argv, ...WORST] : run.argv);
    if (entry !== undefined) return denial(entry, run.text);
  }
  for (const assignment of out.assignments) {
    const entry = deniedAssignment(assignment.name);
    if (entry !== undefined) return denial(entry, assignment.text);
  }
  for (const argvs of out.pipelines) {
    const entry = deniedPipeline(argvs);
    if (entry !== undefined) return denial(entry, command);
  }
  const refusal = out.refusals[0];
  if (refusal !== undefined) return deny('commands', `can't be checked: ${refusal}`);
  for (const run of out.runs) {
    if (permissions.deny !== undefined && matchesCommand(run.match, permissions.deny)) {
      return deny('commands', `${quote(run.text)} is among the step's denied commands`);
    }
    if (!matchesCommand(run.match, permissions.commands)) {
      return deny('commands', `${quote(run.text)} matches none of the step's commands`);
    }
  }
  const problem = out.problems[0];
  if (problem !== undefined) return deny('commands', problem);
  const reads = checkTargets(out.reads, checkRead, 'read', permissions, ctx);
  if (!reads.allow) return reads;
  return checkTargets(out.writes, checkWrite, 'write', permissions, ctx);
}
