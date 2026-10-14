// The deny set: the commands no step's permissions can allow, matched on a command's argv, not its text (D10).
// STUB (tdd-plan): the set is empty and every check names a wrong entry. TASK-006 fills it.

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
  return word;
}

/** Splits `git …` into its global options, subcommand and arguments. */
export function gitInvocation(_argv: readonly string[]): GitInvocation {
  return { globals: [], args: [] };
}

export const DENY_SET: readonly CommandEntry[] = [];

const STUB: DenyEntry = { name: 'stub', why: 'stub' };

/** The pipeline entry: a download fed into a shell. */
export const PIPE_TO_SHELL: DenyEntry = {
  name: 'curl | sh',
  why: 'downloaded code is never run',
};

/** The entry `argv` falls under, or undefined. */
export function denied(_argv: readonly string[]): DenyEntry | undefined {
  return STUB;
}

/** `curl | sh` when a download in the pipeline feeds a shell after it, through `sudo` or `env` too. */
export function deniedPipeline(_argvs: readonly (readonly string[])[]): DenyEntry | undefined {
  return STUB;
}

/** The environment override entry: a variable that changes which program runs, or makes one run another command. */
export const ENVIRONMENT_OVERRIDE: DenyEntry = {
  name: 'environment override',
  why: 'the variable changes which program runs, or makes one run another command',
};

/** The entry an assignment to `name` falls under, or undefined. `GIT_DIR` and its kin are paths, checked as such. */
export function deniedAssignment(_name: string): DenyEntry | undefined {
  return undefined;
}
