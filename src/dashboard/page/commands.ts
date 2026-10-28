// The CLI commands the page shows to copy. The dashboard's one control moves a queued item: what a person would do
// about a run or a parked item, they do in a terminal, and the page only says how. A run id, a workflow and a dedup key come from run
// and queue files, so each is quoted for the shell unless it is a plain word: a pasted command runs only what it says.

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

/** What a person does with a parked item: queue it again, or drop it. */
export function parkedCommands(workflow: string, dedupKey: string): Command[] {
  const args = `${shellWord(workflow)} ${shellWord(dedupKey)}`;
  return [
    { label: 'requeue', command: `sail queue requeue ${args}` },
    { label: 'drop', command: `sail queue drop ${args}` },
  ];
}
