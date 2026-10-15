// The run view: the run's header, its totals against its budget, its loops and routes, one stage card per call grouped
// by loop iteration, the roster stages not called yet, the pull request it opened, and the CLI commands to copy. The
// cards come from the run model, fed by the run's events. The totals, loops and routes come from the summary in the
// index when there is one, and from the cards otherwise.
//
// Stub (TASK-007): draws nothing.
import type { Summary } from '../../events/summary';
import { html, type SafeHtml } from './html';
import type { RunModel } from './run-model';
import type { UiState } from './ui-state';

/** A URL as a link when it is http(s), else as text. */
export function link(_url: string | undefined, _label: string | SafeHtml): SafeHtml {
  return html``;
}

/** The commands to copy, each with its copy button. */
export function commandList(_commands: readonly { label: string; command: string }[]): SafeHtml {
  return html``;
}

/** The run view. `now` is ms since the epoch, for the running cards' durations. */
export function renderRun(
  _model: RunModel,
  _summary: Summary | null | undefined,
  _ui: UiState,
  _now: number,
): SafeHtml {
  return html``;
}

/** The status bar: calls settled of all, tool calls, denials, cost, and whether the run is live. */
export function renderStatus(_model: RunModel, _summary: Summary | null | undefined): SafeHtml {
  return html``;
}
