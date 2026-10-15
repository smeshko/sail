// The CLI commands the page shows to copy. The dashboard controls nothing: what a person would do about a run or a
// parked item, they do in a terminal, and the page only says how. A run id, a workflow and a dedup key come from run
// and queue files, so each is quoted for the shell unless it is a plain word: a pasted command runs only what it says.
//
// Stub (TASK-001): signatures only.

export interface Command {
  label: string;
  command: string;
}

/** `word` as one shell word: as it is when plain, else single-quoted. */
export function shellWord(word: string): string {
  return word;
}

/** `sail show` always, `--follow` while the run runs, and `sail resume` once it is suspended. */
export function runCommands(_runId: string, _status: string | undefined): Command[] {
  return [];
}

/** What a person does with a parked item: queue it again, or drop it. */
export function parkedCommands(_workflow: string, _dedupKey: string): Command[] {
  return [];
}
