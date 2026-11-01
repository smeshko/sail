// The CLI commands the page shows to copy for a run (`runCommands`): the queue's changes are buttons, not commands. A
// run id comes from run files, so it is quoted for the shell unless it is a plain word: a pasted command runs only what
// it says.

export interface Command {
  label: string;
  command: string;
}

/** `word` as one shell word: as it is when plain, else single-quoted. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9._:@#%+=/-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** `sail show` always, `--follow` while the run runs, and `sail resume` once it is suspended. */
export function runCommands(runId: string, status: string | undefined): Command[] {
  const run = shellWord(runId);
  const commands: Command[] = [{ label: 'show', command: `sail show ${run}` }];
  if (status === 'running') commands.push({ label: 'follow', command: `sail show ${run} --follow` });
  if (status === 'suspended') commands.push({ label: 'resume', command: `sail resume ${run}` });
  return commands;
}
