// The queue panel: each watched workflow's queue, with its polling, its items by state, and its recent events from the
// queue's own stream. With no queue anywhere it renders nothing, and the panel is hidden. A parked item shows the
// commands that requeue or drop it, to copy: the dashboard changes nothing itself.
//
// Stub (TASK-006): draws nothing.
import type { QueueEvent } from '../../events/types';
import { html, type SafeHtml } from './html';
import type { QueuePanel, WatchState } from './index-model';
import type { UiState } from './ui-state';

/** What the shell has heard on a queue's stream: its last events and its watch state. */
export interface QueueStream {
  recent: readonly QueueEvent[];
  watch: WatchState;
}

/** The key a queue's stream is kept under: `<repo>/<workflow>`. */
export const queueId = (_repo: string, _workflow: string) => '';

/** One line about a queue event. An unknown type shows its type alone. */
export function queueEventLine(_event: QueueEvent): string {
  return '';
}

/** Every queue panel, or nothing when there is none, which hides the panel. */
export function renderQueues(
  _panels: readonly QueuePanel[],
  _streams: Readonly<Record<string, QueueStream>>,
  _ui: UiState,
  _now: number,
): SafeHtml {
  return html``;
}
