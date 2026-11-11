// What a person has chosen on the page, which every view reads: the open run, card and tab, whether the card's timeline
// is open, which of its tool calls and which kinds of its entries it hides, the queue open in its place with its folded
// sections, the list's view, filter, cursor and folded groups, the theme, the offset their
// clock is at, and the file open in the drawer. `act` is the one state of carrying an action out: the parameters typed. It
// holds nothing about the runs themselves.

import type { RefusedStart, Subject } from './action-registry';
import type { DialogView } from './dialog-view';
import type { ViewName } from './list-model';
import type { Toast } from './toasts';

export const TABS = ['overview', 'files', 'permissions', 'log'] as const;
export type InspectorTab = (typeof TABS)[number];

/** The kinds of entry a timeline can hide. Every thinking, message, tool call and script command is of exactly one. */
export const FILTERS = ['thinking', 'messages', 'tools', 'scripts', 'errors'] as const;
export type TimelineFilter = (typeof FILTERS)[number];

export const THEMES = ['dark', 'light', 'system'] as const;
export type Theme = (typeof THEMES)[number];

/** Carrying an action out, for every action alike: what was typed for each action's parameters, kept across a draw. */
export interface ActState {
  drafts: Record<string, Record<string, string>>;
}

/** Where the focused subject comes from: the row under the pointer, the keyboard's cursor, or the open run or queue. */
export type FocusSource = 'hover' | 'cursor' | 'open';

/** The subject each source holds, with the sequence number of its last change: the highest is the focused subject. */
export interface FocusState {
  seq: number;
  hover?: { subject: Subject; at: number };
  cursor?: { subject: Subject; at: number };
  open?: { subject: Subject; at: number };
}

/**
 * One step the command menu asks: the `at`-th parameter of an action for a subject, with what the earlier steps took,
 * or the choice of the queue an action without a subject is done to.
 */
export type MenuStep =
  | {
      action: string;
      subject: Subject;
      data: Record<string, string>;
      values: Record<string, string>;
      at: number;
    }
  | { pick: 'queue' | 'repo'; action: string };

/** The command menu while it is open: the subject frozen at the open, what is typed, the highlighted row and the steps. */
export interface MenuState {
  mode: 'full' | 'context';
  subject?: Subject;
  query: string;
  /** The highlighted row, by its place in the rows drawn. */
  at: number;
  /** The row a person moved the highlight to, by `rowKey()`: it keeps the highlight while rows before it come and go. */
  row?: string;
  steps: MenuStep[];
  error?: string;
  /** Where a right-click opened it, in the page's pixels. */
  point?: { x: number; y: number };
}

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
  /** The view the list shows, the repository it is narrowed to, what the filter field holds, the entry under the cursor (by id) and the folded groups (by id). */
  view: ViewName;
  repoFilter?: string;
  listFilter: string;
  /** History's status and workflow filters, from the list head's two controls; `completed` is `done`. */
  historyStatus?: 'failed' | 'completed';
  historyWorkflow?: string;
  listCursor?: string;
  listFolded: string[];
  /** The History rows marked with `x`, by row id: the selection. */
  listSelected: string[];
  /** The queue view's folded sections, as `<repo>/<workflow>:<state>`. */
  folded: string[];
  /** Whether the queue view shows its recent events. */
  queueEvents: boolean;
  /** The item whose ⋯ menu is open, by dedup key. */
  itemMenu?: string;
  /** The open run's ⋯ menu that is open, and where: under its list row, or in the run view's view header. One at a time. */
  runMenu?: { runId: string; at: 'row' | 'header' };
  theme: Theme;
  /** Whether the inspector is pinned open: it opens with a selected card without it. */
  pinned: boolean;
  /** Whether the folded sidebar (under 800px) is open over the page. */
  sidebar: boolean;
  /** The card under the keyboard's cursor, by its place in the run view. */
  cursor: number;
  /** Whether the log and the timeline follow their tail. */
  follow: boolean;
  /** The clock's offset east of UTC, in minutes: times are shown at it. */
  tz: number;
  /** The parameters typed for each action. */
  act: ActState;
  /** The confirmation dialog open now, if any. */
  dialog?: DialogView;
  /** The toasts on the stack, oldest first. */
  toasts: Toast[];
  /** The start the CLI last refused with a check a flag overrides, for start anyway. */
  start?: RefusedStart;
  /** The command last copied and whether the clipboard took it, shown on its copy button until it times out. */
  copied?: { text: string; ok: boolean };
  /** The command menu, while it is open. */
  menu?: MenuState;
  /** The subject each source of the focus holds. */
  focus: FocusState;
  /** What a subject reads while a request for it is out, by the id `underwayId()` gives: `stopping…`. */
  underway: Record<string, string>;
}

export function initialUi(tz: number): UiState {
  return {
    tab: 'overview',
    timeline: false,
    opened: [],
    hidden: [],
    view: 'active',
    listFilter: '',
    listFolded: [],
    listSelected: [],
    folded: [],
    queueEvents: false,
    theme: 'dark',
    pinned: false,
    sidebar: false,
    cursor: 0,
    follow: false,
    tz,
    act: { drafts: {} },
    toasts: [],
    underway: {},
    focus: { seq: 0 },
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
