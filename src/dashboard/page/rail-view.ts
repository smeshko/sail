// The rail: every registered repository with its runs, newest first. Finished runs fold into a counted `completed`
// section, open when the person opened it or when it holds the open run, so a long tail of completions never buries
// live work and the selection is never hidden.
//
// Stub (TASK-006): draws nothing.
import { html, type SafeHtml } from './html';
import type { RailRepo } from './index-model';
import type { UiState } from './ui-state';

/** The rail from the index model. */
export function renderRail(_repos: readonly RailRepo[], _ui: UiState): SafeHtml {
  return html``;
}
