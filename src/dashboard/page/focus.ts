// The focused subject: what a person is pointing at, has the cursor on, or has open. Each source holds a subject with the
// sequence number of its last change, and the one that changed last is the focused subject. A source set to the subject
// it already holds is no change, so a redraw under a resting pointer doesn't take the subject back from the keyboard.
// Pure over the state: it reads the store only to find the open run or queue.
import { type Subject, type SubjectKind, subjectOf } from './action-registry';
import { openQueue, type Store } from './store';
import type { FocusSource, UiState } from './ui-state';

const SOURCES: readonly FocusSource[] = ['hover', 'cursor', 'open'];

export function sameSubject(a: Subject | undefined, b: Subject | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Sets what `source` holds, or clears it with undefined. A source that already holds the subject doesn't change. */
export function setFocus(ui: UiState, source: FocusSource, subject: Subject | undefined): void {
  const held = ui.focus[source];
  if (subject === undefined) {
    delete ui.focus[source];
    return;
  }
  if (sameSubject(held?.subject, subject)) return;
  ui.focus[source] = { subject, at: ++ui.focus.seq };
}

/** The subject of the source that changed last, if any source holds one. */
export function focused(ui: UiState): Subject | undefined {
  let best: { subject: Subject; at: number } | undefined;
  for (const source of SOURCES) {
    const held = ui.focus[source];
    if (held !== undefined && (best === undefined || held.at > best.at)) best = held;
  }
  return best?.subject;
}

/** The open queue as a workflow subject, else the open run. */
export function openSubject(store: Store): Subject | undefined {
  const panel = openQueue(store);
  if (panel !== undefined) return { kind: 'workflow', repo: panel.repo, workflow: panel.workflow };
  if (store.run !== undefined) return { kind: 'run', repo: store.run.repo, runId: store.run.runId };
  return undefined;
}

/** Makes the open source what the page has open now. */
export function syncOpen(store: Store): void {
  setFocus(store.ui, 'open', openSubject(store));
}

const ROWS: readonly SubjectKind[] = ['run', 'item', 'workflow', 'repo'];

/** The subject a row's dataset names by its `data-subject`, or undefined for a row that names none. */
export function subjectFrom(data: Readonly<Record<string, string>> | undefined): Subject | undefined {
  const kind = ROWS.find((each) => each === data?.subject);
  return kind === undefined || data === undefined ? undefined : subjectOf([kind], data);
}
