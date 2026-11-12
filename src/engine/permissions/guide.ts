// The section of a session's system prompt on the commands its permissions deny, so the agent writes commands that
// pass rather than learning each rule from a denial. Its hand-written lines describe commands.ts's cd() and git(),
// shell.ts's refusal of a parameter expansion with an operator and paths.ts's scratch region, and change with them: test/engine/permissions/
// guide.test.ts ties each to decideCommand()'s verdict on an example. The deny-set line is built from deny.ts.
import { DENY_SET, ENVIRONMENT_OVERRIDE, PIPE_TO_SHELL } from './deny';

/** The name of each entry of the deny set, then `curl | sh` and `environment override`. */
export function denySetNames(): readonly string[] {
  return [...DENY_SET, PIPE_TO_SHELL, ENVIRONMENT_OVERRIDE].map((entry) => entry.name);
}

/** The section `## Commands the permissions deny`, as lines joined with a newline. */
export function deniedCommands(): string {
  const names = denySetNames()
    .map((name) => `\`${name}\``)
    .join(', ');
  return [
    '## Commands the permissions deny',
    '',
    "Each command is checked against this step's permissions before it runs, and a denied one costs a turn. Write commands",
    'these rules pass:',
    '',
    "- You are already in the workspace, so don't `cd` to it. A `cd` is denied when it leaves the workspace and the stage",
    '  directories, or when its directory can\'t be resolved before it runs, as with `cd -`, `cd ~` or `cd "$(…)"`. For',
    '  git in another directory of the workspace, use `git -C <dir>`.',
    '- Pass git literal arguments. One that holds a command substitution, or a variable set from one, is denied, as in',
    '  `git diff $BASE...HEAD`: run the command that computes the value in a call of its own first, then write the value',
    '  out. A variable listed under "Where you work" is fine.',
    '- A parameter expansion with an operator, such as `${NAME:-default}`, is denied in any command: write the value out.',
    '- Scratch files go in `$TMPDIR` (`$TMP` and `$TEMP` name it too), the scratch folder, which you may read and write',
    '  whatever your write globs. A temporary file anywhere else, such as `/tmp`, is denied.',
    `- No step may run these, whatever its permissions: ${names}.`,
    '- A denial names the rule that denied the command and why. Change the command to pass it: the same command is denied',
    '  again.',
  ].join('\n');
}
