// The page's shell. `boot(host)` holds what is on screen and keeps it live:
//
// - One index socket feeds the rail, needs attention, the queues and the open run's summary. The first index opens the
//   newest running run, else the newest run, and a selection is kept while its run is still listed.
// - One run socket is open at a time, for the open run, and its events are folded into the run model. A socket that
//   closes without `end` reconnects after 2 s and starts the model again, since the replay sends everything.
// - One queue socket per watched workflow in the index feeds its recent events and its watch state.
// - The inspector reads a call's `result.json` and log over REST. A response for a selection that has changed since is
//   dropped, and a running call's log is read again at most once a second.
// - Clicks arrive as delegated `data-action`s, and keys as keys. Renders are coalesced: a region marked dirty is drawn
//   by one flush at most every 100 ms.
//
// It controls nothing: the only actions change what is shown, and `copy` puts a CLI command on the clipboard.
//
// Stub (TASK-008): boots into nothing.
import type { PageHost } from './host';
import { initialUi, type UiState } from './ui-state';

export const THEME_KEY = 'sail-dashboard-theme';
export const RECONNECT_MS = 2000;
export const FLUSH_MS = 100;
export const LOG_REFRESH_MS = 1000;
/** How many of a queue's events its panel lists. */
export const RECENT_EVENTS = 20;

export interface Page {
  stop(): void;
  /** What the page holds, for tests. */
  readonly ui: UiState;
}

export function boot(_host: PageHost): Page {
  return { ui: initialUi(0), stop() {} };
}
