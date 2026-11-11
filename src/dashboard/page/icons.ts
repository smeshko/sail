// The page's icons, one set for the command menu and the top bar: 16px stroke paths, drawn in the colour of the text
// around them. Pure.
import { raw, type SafeHtml } from './html';

export const ICONS = {
  play: 'M5 3.5v9l7-4.5z',
  stop: 'M4 4h8v8H4z',
  stopNow: 'M2.5 2.5h11v11h-11zM5.5 5.5l5 5M10.5 5.5l-5 5',
  pause: 'M5 3.5v9M11 3.5v9',
  restart: 'M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5',
  refresh: 'M2.5 8a5.5 5.5 0 0 1 9.5-3.5M13.5 8a5.5 5.5 0 0 1-9.5 3.5M12 2v2.5H9.5M4 14v-2.5h2.5',
  unlock: 'M4 7.5h8v6H4zM6 7.5V5a2 2 0 0 1 4 0',
  plus: 'M8 3v10M3 8h10',
  check: 'M3 8.5l3.5 3.5L13 4.5',
  cross: 'M4 4l8 8M12 4l-8 8',
  move: 'M8 2.5v11M5 5.5l3-3 3 3M5 10.5l3 3 3-3',
  eye: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
  eyeOff:
    'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zM2.5 2.5l11 11',
  folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  ticket: 'M2.5 5h11v2a1 1 0 0 0 0 2v2h-11V9a1 1 0 0 0 0-2z',
  run: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM6.8 5.8v4.4L10.3 8z',
  sun: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1',
  panel: 'M2 3h12v10H2zM10 3v10',
  sidebar: 'M2 3h12v10H2zM6 3v10',
  link: 'M2.5 5.5h7v8h-7zM6.5 2.5h7v8',
  arrow: 'M3 8h10M9 4l4 4-4 4',
} as const;

export type IconName = keyof typeof ICONS;

/** The `<svg>` of an icon, classed `cls`. */
export const icon = (name: IconName, cls: string): SafeHtml =>
  raw(`<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`);
