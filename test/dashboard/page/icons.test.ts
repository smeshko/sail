// The icon set the command menu and the top bar share: every icon has a path of its own.
import { expect, test } from 'bun:test';
import { ICONS, type IconName, icon } from '../../../src/dashboard/page/icons';

test('every icon has a non-empty path', () => {
  const names = Object.keys(ICONS) as IconName[];
  expect(names.length).toBeGreaterThan(20);
  expect(names.filter((name) => ICONS[name].length === 0)).toEqual([]);
});

test('icon draws the 16px svg with its class and path', () => {
  expect(icon('stop', 'cmdk-ico').value).toBe(
    '<svg class="cmdk-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4h8v8H4z"/></svg>',
  );
});

test('no two icons share a path, but eyeOff is eye with a slash', () => {
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const [name, path] of Object.entries(ICONS)) {
    const other = seen.get(path);
    if (other !== undefined) clashes.push(`${name} = ${other}`);
    seen.set(path, name);
  }
  expect(clashes).toEqual([]);
  expect(ICONS.eyeOff.startsWith(ICONS.eye)).toBe(true);
});

test('stop, stop now and suspend and hold draw three different icons', () => {
  expect(new Set([ICONS.stop, ICONS.stopNow, ICONS.pause]).size).toBe(3);
  expect(ICONS.sidebar).not.toBe(ICONS.panel);
  expect(ICONS.link.length).toBeGreaterThan(0);
});
