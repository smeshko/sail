// Normalizes a parsed script into simple commands: wrappers, env and cd are resolved, git's global options and nested
// shells are unwrapped, and every path is resolved. A refusal is recorded with its rule; `normalize` throws the first.
import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { resolveReal, rootOf } from './paths';
import { classifyRedirect, type RedirectTarget, substitutionScripts } from './substitute';
import { type Joiner, type Script, type Segment, tokenize, Unparseable, type Word } from './tokenize';
import { Refusal, type Roots } from './types';

/** One simple command, as the deny set and the patterns see it. */
export interface NormalizedCommand {
  /** The unquoted words after the wrappers and assignments are stripped. */
  readonly argv: readonly string[];
  /** The directory the command runs in: the worktree, or a `cd` target inside a root. */
  readonly cwd: string;
  /** The environment assignments the command runs with. */
  readonly env: Readonly<Record<string, string>>;
  /** Resolved paths the command writes through its redirect targets. Path-like arguments are checked, not classified. */
  readonly writes: readonly string[];
  /** Resolved paths the command reads through its redirect sources. */
  readonly reads: readonly string[];
  /** The script the command was parsed from, whose pipeline the deny set reads (a nested `bash -c` has its own). */
  readonly pipeline: Script;
}

/** The commands of a script and every refusal found in it. A refused part does not hide the commands around it. */
export interface Analysis {
  readonly commands: readonly NormalizedCommand[];
  readonly refusals: readonly Refusal[];
}

interface Context {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** The script the segment belongs to, so a command knows what it is piped from and into, even when nested. */
  readonly pipeline: Script;
  /** How many scripts (eval, a nested shell, a substitution) the segment is inside. Bounded, so the walk cannot overflow. */
  readonly depth: number;
}

/** How deeply scripts may nest through eval, nested shells and substitutions before the walk refuses. */
const MAX_DEPTH = 32;

interface Walk {
  readonly roots: Roots;
  readonly commands: NormalizedCommand[];
  readonly refusals: Refusal[];
}

const WRAPPERS = new Set(['command', 'exec', 'nohup', 'time']);
const SHELLS = new Set(['sh', 'bash', 'zsh']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_PATH_VARS = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']);
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
]);
const GIT_PATH_OPTIONS = new Set(['-C', '--git-dir', '--work-tree']);
const INJECTING_OPTIONS = new Set(['-c', '--config-env', '--exec-path']);
const NULL_DEVICE = '/dev/null';
// Builtins that change the shell's variables or run a file. The engine does not follow them into later segments.
const SHELL_STATE = new Set(['export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'alias', 'source', '.']);

/** Normalizes every simple command of a script, unwrapping nested shells. Throws `Refusal` for the first refusal. */
export function normalize(script: Script, roots: Roots): NormalizedCommand[] {
  const { commands, refusals } = analyse(script, roots);
  const [first] = refusals;
  if (first !== undefined) throw first;
  return [...commands];
}

/** Normalizes a script and returns its commands and every refusal, without throwing. */
export function analyse(script: Script, roots: Roots): Analysis {
  const walk: Walk = { roots, commands: [], refusals: [] };
  walkScript(walk, script, { cwd: roots.worktree, env: {}, pipeline: script, depth: 0 });
  return { commands: walk.commands, refusals: walk.refusals };
}

/** A git command's subcommand and its arguments, past git's global options. Null when no subcommand is named. */
export function gitSubcommand(
  argv: readonly string[],
): { readonly name: string; readonly args: readonly string[] } | null {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('-')) return { name: arg, args: argv.slice(i + 1) };
    if (GIT_VALUE_OPTIONS.has(arg)) i += 1;
  }
  return null;
}

/** The command a segment's words run after the assignments and wrappers in front of it, or '' when there is none. */
export function leadingCommand(words: readonly Word[]): string {
  for (const word of words) {
    if (ASSIGNMENT.test(word.raw) || WRAPPERS.has(word.text) || word.text === 'env') continue;
    return word.text;
  }
  return '';
}

/** Walks a script and returns the directory it leaves the shell in. */
/** Walks a script and returns the directory it leaves the shell in. */
function walkScript(walk: Walk, script: Script, start: Context): string {
  let cwd = start.cwd;
  let jobCwd = cwd;
  let pipeCwd = cwd;
  let previous: Segment | undefined;
  script.forEach((segment, index) => {
    // A shell that `curl` pipes into is the deny set's case (deny:curl-pipe-shell), so it is not refused here.
    const fedByCurl =
      segment.before === '|' && previous !== undefined && basename(leadingCommand(previous.words)) === 'curl';
    // A job is a run of segments joined by && or || or |. A job before `&` runs in the background, in a subshell, and
    // so does each member of a pipeline. Neither moves the shell, so each starts from the directory it began in.
    if (!isJoined(segment.before)) jobCwd = cwd;
    if (segment.before !== '|') pipeCwd = cwd;
    const backgrounded = jobIsBackgrounded(script, index);
    const pipelined = segment.before === '|' || script[index + 1]?.before === '|';
    const base = backgrounded ? jobCwd : pipelined ? pipeCwd : cwd;
    const after = walkSegment(
      walk,
      segment,
      { cwd: base, env: start.env, pipeline: script, depth: start.depth },
      fedByCurl,
    );
    previous = segment;
    if (backgrounded || pipelined) return;
    // A cd after && or || runs only if the one before it succeeds, so the directory after it is not known.
    if ((segment.before === '&&' || segment.before === '||') && after !== cwd) {
      walk.refusals.push(new Refusal('command:unparseable', 'a directory change inside && or ||'));
    }
    cwd = after;
  });
  return cwd;
}

/** Whether a segment joins to the one before it in the same job: a conditional or a pipe. */
function isJoined(joiner: Joiner): boolean {
  return joiner === '&&' || joiner === '||' || joiner === '|';
}

/** Whether the job a segment belongs to is followed by `&`, so that the whole job runs in the background. */
function jobIsBackgrounded(script: Script, index: number): boolean {
  let last = index;
  while (script[last + 1] !== undefined && isJoined(script[last + 1]?.before ?? null)) last++;
  return script[last + 1]?.before === '&';
}

/** Walks one segment. A refusal that stops it is recorded, and the segment yields no command. */
function walkSegment(walk: Walk, segment: Segment, ctx: Context, fedByCurl: boolean): string {
  try {
    return segmentBody(walk, segment, ctx, fedByCurl);
  } catch (error) {
    if (error instanceof Refusal) walk.refusals.push(error);
    else if (error instanceof Unparseable) walk.refusals.push(new Refusal('command:unparseable', error.reason));
    else throw error;
    return ctx.cwd;
  }
}

function segmentBody(walk: Walk, segment: Segment, ctx: Context, fedByCurl: boolean): string {
  if (ctx.depth >= MAX_DEPTH) throw new Unparseable('commands nested too deeply to check');
  const { words, redirects } = segment;
  const own: Record<string, string> = {};
  let index = 0;
  for (;;) {
    const word = words[index];
    if (word === undefined) break;
    if (ASSIGNMENT.test(word.raw)) {
      assignment(walk, word, own, ctx.cwd);
    } else if (word.text === 'env' && !word.unsafe) {
      // `env` takes assignments only: an option such as `-i` could change what runs, so it is refused.
      if (words[index + 1]?.text.startsWith('-')) throw new Unparseable('env with options');
    } else if (!(WRAPPERS.has(word.text) && !word.unsafe)) {
      break;
    }
    index += 1;
  }
  const env = { ...ctx.env, ...own };
  // bash runs the file BASH_ENV names before any command, so the commands it would check are not all the code it runs.
  if (env.BASH_ENV !== undefined) throw new Unparseable('BASH_ENV names a startup file the engine does not read');
  const scoped: Context = { cwd: ctx.cwd, env, pipeline: ctx.pipeline, depth: ctx.depth + 1 };
  for (const word of [...words, ...redirects.map((redirect) => redirect.target)]) {
    for (const body of substitutionScripts(word)) walkScript(walk, body, scoped);
  }
  const writes: string[] = [];
  const reads: string[] = [];
  for (const redirect of redirects) {
    const target = classifyRedirect(redirect);
    if (target !== null) redirectPath(walk, target, ctx.cwd, writes, reads);
  }
  const argvWords = words.slice(index);
  const argv = argvWords.map((word) => word.text);
  const [name = '', ...args] = argv;
  const commandWord = argvWords[0];
  if (commandWord === undefined) {
    emit(walk, argv, ctx, env, writes, reads);
    return ctx.cwd;
  }
  if (commandWord.unsafe) throw new Unparseable('a command name the engine cannot read');
  if (SHELL_STATE.has(argv[0] ?? '')) throw new Unparseable(`${argv[0]} changes the shell's state or runs a file`);
  // Bash expands `{a,b}` and `{1..3}` into several words, so the argv the deny set reads would not be the one that runs.
  if (argvWords.some((word) => braceExpands(word.raw))) {
    throw new Unparseable('a brace expansion the engine does not expand');
  }
  if (name === 'cd') {
    const next = changeDirectory(walk.roots, args, ctx.cwd);
    if (writes.length > 0 || reads.length > 0) emit(walk, argv, ctx, env, writes, reads);
    return next;
  }
  // Git is checked by its name, so a path to it (`/usr/bin/git`) gets the same checks as `git`.
  const isGit = basename(name) === 'git';
  if (isGit) checkGitOptions(walk, args, ctx.cwd, env);
  // A git path option's value is checked by checkGitOptions, against the directory git has reached by then.
  const checked = isGit ? gitPathValueIndexes(args) : new Set<number>();
  argvWords.slice(1).forEach((arg, index) => {
    if (!checked.has(index)) checkArgument(walk, arg, ctx.cwd);
  });
  if (name === 'eval' || SHELLS.has(basename(name))) {
    const piped = fedByCurl && name !== 'eval';
    if (writes.length > 0 || reads.length > 0 || piped) emit(walk, argv, ctx, env, writes, reads);
    if (piped) return ctx.cwd;
    const inner = name === 'eval' ? args.join(' ') : shellScript(args);
    const after = walkScript(walk, tokenize(inner), scoped);
    // eval runs in this shell, so its cd stays; a shell started with -c runs in a child process, so its cd does not.
    return name === 'eval' ? after : ctx.cwd;
  }
  emit(walk, argv, ctx, env, writes, reads);
  return ctx.cwd;
}

function emit(
  walk: Walk,
  argv: readonly string[],
  ctx: Context,
  env: Readonly<Record<string, string>>,
  writes: readonly string[],
  reads: readonly string[],
): void {
  walk.commands.push({ argv, cwd: ctx.cwd, env, writes: [...writes], reads: [...reads], pipeline: ctx.pipeline });
}

function assignment(walk: Walk, word: Word, own: Record<string, string>, cwd: string): void {
  const eq = word.text.indexOf('=');
  const name = word.text.slice(0, eq);
  const value = word.text.slice(eq + 1);
  if (GIT_PATH_VARS.has(name) && !insideRoots(walk.roots, value, cwd)) {
    walk.refusals.push(new Refusal('git:outside-roots', `${name} points outside the run's roots`));
  }
  own[name] = value;
}

function redirectPath(walk: Walk, target: RedirectTarget, cwd: string, writes: string[], reads: string[]): void {
  // The null device takes what a command writes and gives nothing back: no file is reached, so it needs no root.
  if (target.path === NULL_DEVICE) return;
  const resolved = resolveReal(target.path, cwd);
  const root = resolved === null ? null : rootOf(resolved, walk.roots);
  if (target.kind === 'write') {
    if (resolved !== null && (root === 'worktree' || root === 'stageOut')) writes.push(resolved);
    else walk.refusals.push(new Refusal('write:outside-roots', `${target.path} is not a path the step may write`));
  } else if (resolved !== null && root !== null) {
    reads.push(resolved);
  } else {
    walk.refusals.push(new Refusal('read:outside-roots', `${target.path} is outside the run's roots`));
  }
}

/**
 * Checks one argument: an expansion is refused, since its value can change the argv that the deny set reads (a
 * substitution's output included), and a path-like value must stay in the roots.
 */
function checkArgument(walk: Walk, word: Word, cwd: string): void {
  if (word.unsafe && /[$`]/.test(word.text)) {
    throw new Unparseable('an argument with an expansion');
  }
  const value = pathValue(word.text);
  if (isPathLike(value) && !insideRoots(walk.roots, value, cwd)) {
    walk.refusals.push(new Refusal('path:outside-roots', `${value} is outside the run's roots`));
  }
}

/** The value of a `--flag=value` argument, or the argument itself. */
function pathValue(text: string): string {
  const eq = text.indexOf('=');
  return text.startsWith('-') && eq >= 0 ? text.slice(eq + 1) : text;
}

function isPathLike(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~') || value.split('/').includes('..');
}

/** Whether a value names a place inside a root. A value with an expansion is never known to be, so it is outside. */
function insideRoots(roots: Roots, value: string, cwd: string): boolean {
  if (/[$`]/.test(value)) return false;
  const resolved = resolveReal(value, cwd);
  return resolved !== null && rootOf(resolved, roots) !== null;
}

/** Whether a word has an unquoted brace pair with a comma or a `..` range inside, which bash expands into words. */
function braceExpands(raw: string): boolean {
  const unquoted = raw.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\\./g, '');
  return /\{[^{}\s]*(,|\.\.)[^{}\s]*\}/.test(unquoted);
}

/** The indexes of a git command's arguments that are the value of a path option, such as `-C ..`. */
function gitPathValueIndexes(args: readonly string[]): Set<number> {
  const found = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('-')) break;
    if (GIT_PATH_OPTIONS.has(arg)) found.add(i + 1);
    if (GIT_VALUE_OPTIONS.has(arg) || GIT_PATH_OPTIONS.has(arg)) i += 1;
  }
  return found;
}

function checkGitOptions(
  walk: Walk,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): void {
  // Git applies each -C in turn, and reads a relative path after them, so each is relative to where the earlier -C led.
  let effective = cwd;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('-')) break;
    const eq = arg.indexOf('=');
    const longForm = arg.startsWith('--') && eq >= 0;
    const flag = longForm ? arg.slice(0, eq) : arg;
    if (INJECTING_OPTIONS.has(flag)) {
      // Configuration and helper paths change what git runs (a core.fsmonitor or an alias is code), with no list complete.
      walk.refusals.push(new Refusal('command:unparseable', `${flag} changes git's configuration or helpers`));
    }
    if (GIT_PATH_OPTIONS.has(flag)) {
      const value = longForm ? arg.slice(eq + 1) : args[i + 1];
      if (value === undefined) throw new Unparseable('a git option with no value');
      if (!insideRoots(walk.roots, value, effective)) {
        walk.refusals.push(new Refusal('git:outside-roots', `git ${flag} ${value} is outside the run's roots`));
      }
      if (flag === '-C') effective = resolveReal(value, effective) ?? effective;
      if (!longForm) i += 1;
    } else if (GIT_VALUE_OPTIONS.has(flag) && !longForm) {
      i += 1;
    }
  }
  for (const name of GIT_PATH_VARS) {
    const value = env[name];
    if (value !== undefined && !insideRoots(walk.roots, value, effective)) {
      walk.refusals.push(new Refusal('git:outside-roots', `${name} points outside the run's roots`));
    }
  }
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_CONFIG_') || name === 'GIT_EXEC_PATH') {
      walk.refusals.push(new Refusal('command:unparseable', `${name} changes git's configuration or helpers`));
    }
  }
}

/** The script a shell runs with `-c`. A shell with no `-c` runs an opaque file or stdin, which is refused. */
function shellScript(args: readonly string[]): string {
  const dash = args.findIndex((arg) => !arg.startsWith('-'));
  const flags = dash < 0 ? args : args.slice(0, dash);
  const script = dash < 0 ? undefined : args[dash];
  if (script === undefined || !flags.some((flag) => /^-[A-Za-z]*c/.test(flag))) {
    throw new Refusal('command:unparseable', 'a shell runs only a -c script the engine can read');
  }
  // A login or interactive shell sources startup files (~/.bash_profile, ~/.bashrc) that the engine does not read.
  if (flags.some((flag) => /^-[A-Za-z]*[li]/.test(flag) || /^--(login|interactive|rcfile|init-file)/.test(flag))) {
    throw new Refusal('command:unparseable', 'a login or interactive shell reads startup files the engine does not');
  }
  return script;
}

/** The directory a `cd` names, when it is one plain directory inside a root. */
function changeDirectory(roots: Roots, args: readonly string[], cwd: string): string {
  const [target] = args;
  if (args.length !== 1 || target === undefined || target.startsWith('-')) {
    throw new Unparseable('cd without one plain directory');
  }
  // bash's cd is logical: it removes `..` from the path lexically, then enters the path it names. The shell's directory
  // is that path, so later relative paths resolve from it; the directory it reaches must still be inside the roots.
  const logical = resolve(cwd, target);
  const reached = resolveReal(logical, '/');
  if (reached === null || rootOf(reached, roots) === null) {
    throw new Refusal('path:outside-roots', `cd to ${target} is outside the run's roots`);
  }
  // A cd that fails leaves the shell where it was, so the later commands would run somewhere the engine did not track.
  if (!statSync(logical, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Unparseable(`cd to ${target}, which is not an existing directory`);
  }
  return logical;
}
