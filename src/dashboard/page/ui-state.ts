// What a person has chosen on the page, which every view reads: the open run, card and tab, whether the card's timeline
// is open, which of its tool calls and which kinds of its entries it hides, the queue open in its place with its folded
// sections, the rail's open sections and opened groups, whether needs attention is open, the theme, the offset their
// clock is at, and the file open in the drawer. It holds nothing about the runs themselves.

export const TABS = ['overview', 'files', 'permissions', 'log'] as const;
export type InspectorTab = (typeof TABS)[number];

/** The kinds of entry a timeline can hide. Every thinking, message, tool call and script command is of exactly one. */
export const FILTERS = ['thinking', 'messages', 'tools', 'scripts', 'errors'] as const;
export type TimelineFilter = (typeof FILTERS)[number];

export const THEMES = ['dark', 'light', 'system'] as const;
export type Theme = (typeof THEMES)[number];

export interface UiState {
  repo?: string;
  runId?: string;
  /** The selected card's key. */
  key?: string;
  /** The queue the centre shows in place of the run, as `<repo>/<workflow>`. */
  queue?: string;
  /** Whether the centre shows the selected card's timeline, rather than the run's cards. */
  timeline: boolean;
  /** The timeline's tool calls opened to show their input and result, by call id. */
  opened: string[];
  /** The kinds of entry every timeline hides. */
  hidden: TimelineFilter[];
  tab: InspectorTab;
  /** The run file open in the drawer: its name and its path in the run directory. */
  file?: { name: string; path: string };
  /** The log stream the log tab shows, when one is chosen. */
  stream?: string;
  /** The step the log tab shows for a multi-step call, when one is chosen. */
  step?: string;
  /** The rail's open sections, as `<repo>/<workflow>:completed`. */
  open: string[];
  /** The rail's opened repositories and workflows, as `<repo>` and `<repo>/<workflow>`: every one starts folded. */
  expanded: string[];
  /** Whether the needs attention pane is open. */
  attention: boolean;
  /** The queue view's folded sections, as `<repo>/<workflow>:<state>`. */
  folded: string[];
  /** Whether the queue view shows its recent events. */
  queueEvents: boolean;
  /** Why the last move was refused, shown in the queue view until the next move succeeds. */
  queueNotice?: string;
  theme: Theme;
  inspector: boolean;
  /** The card under the keyboard's cursor, by its place in the run view. */
  cursor: number;
  /** Whether the log and the timeline follow their tail. */
  follow: boolean;
  /** The clock's offset east of UTC, in minutes: times are shown at it. */
  tz: number;
}

export function initialUi(tz: number): UiState {
  return {
    tab: 'overview',
    timeline: false,
    opened: [],
    hidden: [],
    open: [],
    expanded: [],
    attention: false,
    folded: [],
    queueEvents: false,
    theme: 'dark',
    inspector: true,
    cursor: 0,
    follow: false,
    tz,
  };
}

/** The pill class a status or an outcome is drawn with. */
export function pillOf(state: string | undefined): string {
  switch (state) {
    case 'completed':
    case 'passed':
    case 'done':
      return 'p-pass';
    case 'failed':
    case 'error':
      return 'p-fail';
    case 'running':
      return 'p-run';
    case 'suspended':
    case 'blocked':
      return 'p-warn';
    case 'pending':
    case undefined:
      return 'p-pend';
    default:
      return 'p-skip';
  }
}
