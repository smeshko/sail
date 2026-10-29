// The deny set: the commands no step's permissions can allow, matched on a command's argv, not its text (D10).

/** One entry of the deny set. */
export interface DenyEntry {
  /** What a reason quotes, such as `git checkout`. */
  readonly name: string;
  /** Why it is denied, in one clause. */
  readonly why: string;
}

/** An entry matched on one simple command's argv. */
export interface CommandEntry extends DenyEntry {
  readonly matches: (argv: readonly string[]) => boolean;
}

/** A git invocation split into its global options, its subcommand and the subcommand's arguments. */
export interface GitInvocation {
  /** Each global option, with its value when it takes one. */
  readonly globals: readonly { readonly name: string; readonly value?: string }[];
  readonly subcommand?: string;
  readonly args: readonly string[];
  /** A global option git might accept but this list doesn't know: what it does can't be checked. */
  readonly unknown?: string;
}

/** The last segment of a command name: `/bin/rm` is `rm`. */
export function commandName(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
const GIT_FLAGS = new Set([
  '--no-pager',
  '-p',
  '--paginate',
  '-P',
  '--bare',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-lazy-fetch',
  '--exec-path',
  '--version',
  '-v',
  '--help',
  '-h',
  '--html-path',
  '--man-path',
  '--info-path',
]);

/** Splits `git …` into its global options, subcommand and arguments. */
export function gitInvocation(argv: readonly string[]): GitInvocation {
  const globals: { name: string; value?: string }[] = [];
  let i = 1;
  while (i < argv.length) {
    const word = argv[i] as string;
    if (!word.startsWith('-')) break;
    const eq = word.indexOf('=');
    const name = word.startsWith('--') && eq !== -1 ? word.slice(0, eq) : word;
    if (name !== word && (GIT_VALUED.has(name) || name === '--exec-path')) {
      globals.push({ name, value: word.slice(eq + 1) });
      i++;
    } else if (GIT_VALUED.has(word)) {
      const value = argv[i + 1];
      if (value === undefined) return { globals, args: [], unknown: word };
      globals.push({ name: word, value });
      i += 2;
    } else if (GIT_FLAGS.has(word)) {
      globals.push({ name: word });
      i++;
    } else {
      return { globals, args: argv.slice(i + 1), unknown: word };
    }
  }
  const subcommand = argv[i];
  return subcommand === undefined ? { globals, args: [] } : { globals, subcommand, args: argv.slice(i + 1) };
}

/** The options before `--`: long ones by any prefix they abbreviate, short clusters as their letters. */
interface Flags {
  /** Whether a long option given is `name` or a prefix of it: git and GNU getopt take any unambiguous prefix. */
  readonly long: (name: string) => boolean;
  readonly short: ReadonlySet<string>;
}

function flags(args: readonly string[]): Flags {
  const given: string[] = [];
  const short = new Set<string>();
  for (const arg of args) {
    if (arg === '--') break;
    if (arg.startsWith('--')) given.push(arg.split('=')[0] as string);
    else if (arg.startsWith('-') && arg.length > 1) for (const letter of arg.slice(1)) short.add(letter);
  }
  return { long: (name) => given.some((flag) => flag.length > 2 && name.startsWith(flag)), short };
}

/** Values of listed options, conservatively matching long prefixes and letters anywhere in short clusters. */
export function optionValues(
  args: readonly string[],
  long: readonly string[],
  short = '',
): { option: string; value?: string }[] {
  const found: { option: string; value?: string }[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      const option = long.find((option) => name.length > 2 && option.startsWith(name));
      if (option !== undefined) {
        const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
        found.push(value === undefined ? { option } : { option, value });
      }
    } else if (arg.startsWith('-')) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j] as string;
        if (!short.includes(letter)) continue;
        const option = `-${letter}`;
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
        found.push(value === undefined ? { option } : { option, value });
        break;
      }
    }
    // An unlisted option may take `--` as its value. Git then keeps parsing options;
    // without that option's grammar we must conservatively keep scanning too.
    if (args[i + 1] === '--' && arg.startsWith('-') && !arg.includes('=')) i++;
  }
  return found;
}

const GIT_PROGRAMS: Record<string, { long: string[]; short?: string; path?: true }> = {
  clone: { long: ['--upload-pack', '--template'], short: 'u' },
  fetch: { long: ['--upload-pack'] },
  pull: { long: ['--upload-pack'] },
  'ls-remote': { long: ['--upload-pack', '--exec'] },
  push: { long: ['--receive-pack', '--exec'] },
  archive: { long: ['--exec'] },
  init: { long: ['--template'] },
  grep: { long: ['--open-files-in-pager'], short: 'O' },
  instaweb: { long: ['--httpd'], short: 'd' },
  'send-email': { long: ['--smtp-server'], path: true },
};

function git(argv: readonly string[], subcommand: string): readonly string[] | undefined {
  if (commandName(argv[0] ?? '') !== 'git') return undefined;
  const invocation = gitInvocation(argv);
  return invocation.subcommand === subcommand ? invocation.args : undefined;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const FETCHERS = new Set(['curl', 'wget']);
const ELEVATORS = new Set(['sudo', 'doas']);

export const DENY_SET: readonly CommandEntry[] = [
  {
    name: 'git program option',
    why: 'the option names a program, or a template of hooks, for git to run',
    matches: (argv) => {
      if (commandName(argv[0] ?? '') !== 'git') return false;
      const { subcommand, args } = gitInvocation(argv);
      const grammar = GIT_PROGRAMS[subcommand ?? ''];
      return (
        grammar !== undefined &&
        optionValues(args, grammar.long, grammar.short).some(
          ({ value }) => grammar.path !== true || value?.startsWith('/') === true,
        )
      );
    },
  },
  {
    name: 'rm -rf',
    why: 'a recursive forced delete is never an agent step',
    matches: (argv) => {
      if (commandName(argv[0] ?? '') !== 'rm') return false;
      const { long, short } = flags(argv.slice(1));
      const recursive = short.has('r') || short.has('R') || long('--recursive');
      return recursive && (short.has('f') || long('--force'));
    },
  },
  {
    name: 'find -delete',
    why: 'find -delete deletes recursively, as rm -rf does',
    matches: (argv) => commandName(argv[0] ?? '') === 'find' && argv.includes('-delete'),
  },
  {
    name: 'git push --force',
    why: 'a forced push rewrites what others have',
    matches: (argv) => {
      const args = git(argv, 'push');
      if (args === undefined) return false;
      const { long, short } = flags(args);
      const forced = ['--force', '--force-with-lease', '--force-if-includes', '--mirror'].some(long);
      return forced || short.has('f') || args.some((arg) => arg.startsWith('+'));
    },
  },
  {
    name: 'git reset --hard',
    why: 'a hard reset throws away work',
    matches: (argv) => {
      const args = git(argv, 'reset');
      return args !== undefined && flags(args).long('--hard');
    },
  },
  {
    name: 'git clean -f',
    why: 'a forced clean deletes untracked files',
    matches: (argv) => {
      const args = git(argv, 'clean');
      if (args === undefined) return false;
      const { long, short } = flags(args);
      return short.has('f') || long('--force');
    },
  },
  {
    name: 'git branch -D',
    why: 'a forced branch delete loses commits',
    matches: (argv) => {
      const args = git(argv, 'branch');
      if (args === undefined) return false;
      const { long, short } = flags(args);
      const remove = short.has('d') || long('--delete');
      return short.has('D') || (remove && (short.has('f') || long('--force')));
    },
  },
  {
    name: 'git checkout',
    why: 'an agent never changes branches or discards files in its worktree (ADR-0018)',
    matches: (argv) => git(argv, 'checkout') !== undefined,
  },
  {
    name: 'git switch',
    why: 'an agent never changes branches in its worktree (ADR-0018)',
    matches: (argv) => git(argv, 'switch') !== undefined,
  },
  {
    name: 'sudo',
    why: 'nothing an agent runs gains privileges',
    matches: (argv) => ELEVATORS.has(commandName(argv[0] ?? '')),
  },
  {
    name: 'git -c',
    why: 'a configuration override can name an alias or a program, which runs any command',
    matches: (argv) => {
      if (commandName(argv[0] ?? '') !== 'git') return false;
      const { globals, subcommand, args } = gitInvocation(argv);
      return (
        globals.some(
          (g) => g.name === '-c' || g.name === '--config-env' || (g.name === '--exec-path' && g.value !== undefined),
        ) ||
        (subcommand === 'clone' && optionValues(args, ['--config'], 'c').length > 0)
      );
    },
  },
];

/** The pipeline entry: a download fed into a shell. */
export const PIPE_TO_SHELL: DenyEntry = {
  name: 'curl | sh',
  why: 'downloaded code is never run',
};

/** The entry `argv` falls under, or undefined. */
export function denied(argv: readonly string[]): DenyEntry | undefined {
  return DENY_SET.find((entry) => entry.matches(argv));
}

/** `curl | sh` when a download in the pipeline feeds a shell after it, through `sudo` or `env` too. */
export function deniedPipeline(argvs: readonly (readonly string[])[]): DenyEntry | undefined {
  let fetched = false;
  for (const argv of argvs) {
    const names = argv.map(commandName);
    const command = names.find((name) => !ELEVATORS.has(name) && name !== 'env' && !name.includes('='));
    if (fetched && command !== undefined && SHELLS.has(command)) return PIPE_TO_SHELL;
    if (command !== undefined && FETCHERS.has(command)) fetched = true;
  }
  return undefined;
}

/** The environment override entry: a variable that changes which program runs or what it runs. */
export const ENVIRONMENT_OVERRIDE: DenyEntry = {
  name: 'environment override',
  why: 'the variable changes which program runs, or makes one run another command',
};

const OVERRIDES = new Set([
  'PATH',
  'IFS',
  'ENV',
  'BASH_ENV',
  'CDPATH',
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
  'PROMPT_COMMAND',
  'PAGER',
  'EDITOR',
  'VISUAL',
  'NODE_OPTIONS',
  'GIT_EXEC_PATH',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'GIT_EXTERNAL_DIFF',
  'GIT_PROXY_COMMAND',
  'GIT_TEMPLATE_DIR',
]);
const PREFIXES = ['LD_', 'DYLD_', 'GIT_CONFIG'];

/** The entry an assignment to `name` falls under, or undefined. `GIT_DIR` and its kin are paths, checked as such. */
export function deniedAssignment(name: string): DenyEntry | undefined {
  return OVERRIDES.has(name) || PREFIXES.some((prefix) => name.startsWith(prefix)) ? ENVIRONMENT_OVERRIDE : undefined;
}
