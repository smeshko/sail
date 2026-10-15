// What a person has chosen on the page, which every view reads: the open run, card and tab, the rail's open sections,
// the theme, and the offset their clock is at. It holds nothing about the runs themselves.

export const TABS = ['overview', 'files', 'permissions', 'log'] as const;
export type InspectorTab = (typeof TABS)[number];

export const THEMES = ['dark', 'light', 'system'] as const;
export type Theme = (typeof THEMES)[number];

export interface UiState {
  repo?: string;
  runId?: string;
  /** The selected card's key. */
  key?: string;
  tab: InspectorTab;
  /** The log stream the log tab shows, when one is chosen. */
  stream?: string;
  /** The rail's open sections, as `<repo>:completed`. */
  open: string[];
  theme: Theme;
  inspector: boolean;
  /** The card under the keyboard's cursor, by its place in the run view. */
  cursor: number;
  /** Whether the log follows its tail. */
  follow: boolean;
  /** The clock's offset east of UTC, in minutes: times are shown at it. */
  tz: number;
}

export function initialUi(tz: number): UiState {
  return { tab: 'overview', open: [], theme: 'dark', inspector: true, cursor: 0, follow: true, tz };
}

/** The pill class a status or an outcome is drawn with. */
export function pillOf(_state: string | undefined): string {
  return '';
}
