// What the page keeps in the browser's storage between visits: the theme, the list's folded groups, the kinds of entry
// the timeline hides, and the needs-attention items a person cleared. Each read falls back when what is stored isn't
// valid, and a write is left to the host, which ignores storage that throws.
import type { PageHost } from './host';
import { FILTERS, THEMES, type Theme, type TimelineFilter } from './ui-state';

export const THEME_KEY = 'sail-dashboard-theme';
/** The `localStorage` key the list's folded groups are kept under, as a JSON list of group ids. */
export const LIST_KEY = 'sail-dashboard-list-folded';
/** Where the kinds of entry the timeline hides are saved, comma-separated. */
export const FILTER_KEY = 'sail-dashboard-timeline-hidden';
/** Where the identities of the needs-attention items a person cleared are kept, as a JSON list of strings. */
export const CLEARED_KEY = 'sail-dashboard-attention-cleared';

/** The saved theme, or undefined when none is saved or it isn't one of the themes. */
export function savedTheme(host: PageHost): Theme | undefined {
  const saved = host.load(THEME_KEY);
  return (THEMES as readonly string[]).includes(saved ?? '') ? (saved as Theme) : undefined;
}

/** The kinds of entry saved as hidden, in the order of `FILTERS`. */
export function savedHidden(host: PageHost): TimelineFilter[] {
  return FILTERS.filter((kind) => (host.load(FILTER_KEY) ?? '').split(',').includes(kind));
}

/** The list's saved folded groups: a list of ids, else none. */
export function savedFolded(host: PageHost): string[] {
  try {
    const stored: unknown = JSON.parse(host.load(LIST_KEY) ?? '[]');
    return Array.isArray(stored) && stored.every((name) => typeof name === 'string') ? (stored as string[]) : [];
  } catch {
    return [];
  }
}

/** The cleared identities in storage now: another tab may have saved some since this one read them. */
export function storedCleared(host: PageHost): string[] {
  try {
    const stored: unknown = JSON.parse(host.load(CLEARED_KEY) ?? '[]');
    return Array.isArray(stored) && stored.every((id) => typeof id === 'string') ? (stored as string[]) : [];
  } catch {
    return [];
  }
}

export function saveCleared(host: PageHost, cleared: ReadonlySet<string>): void {
  host.save(CLEARED_KEY, JSON.stringify([...cleared]));
}
