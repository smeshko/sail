// The inspector: one call, on four tabs. Overview has its facts, output and errors; files, what it produced and how
// each was validated; permissions, the step's permissions and budget from the roster and each denial with the command
// it refused; log, its session or its stdout and stderr. Everything comes from the run's own files: the card from its
// events, the roster from `run:start`, and the call's `result.json` and logs over REST.
//
// Stub (TASK-007): draws nothing.
import { html, type SafeHtml } from './html';
import type { Roster, StageCard } from './run-model';
import type { UiState } from './ui-state';

/** A read the shell made for the inspector: still going, not there, or what came back. */
export type Loaded<T> = { state: 'loading' } | { state: 'missing'; message?: string } | { state: 'loaded'; value: T };

/** The log streams a call of `kind` writes. */
export function streamsOf(_kind: string): string[] {
  return [];
}

/**
 * The inspector for `card`, on `ui.tab`. `result` is the call's `result.json` as the shell read it, and `logText` its
 * log. A result not read yet, or not there, leaves the card's own facts, and says so.
 */
export function renderInspector(
  _card: StageCard | undefined,
  _roster: Roster | undefined,
  _result: Loaded<unknown> | undefined,
  _logText: Loaded<string> | undefined,
  _ui: UiState,
): SafeHtml {
  return html``;
}
