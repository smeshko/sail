// review's reading of a pull request body's Demonstration section: when it says there is no surface.
import { expect, test } from 'bun:test';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const { noSurface } = (await import(join(ROOT, '.sail', 'workflows', 'review', 'demonstration.ts'))) as {
  noSurface(body: string): string | null;
};

const body = (section: string, heading = '## Demonstration') => `## Summary\n\nA change.\n\n${heading}\n\n${section}`;

test.each([['Surface: none'], ['**Surface:** none.'], ['Surface: `none`'], ['none: a refactor'], ['SURFACE: NONE']])(
  'a section starting %p says there is no surface',
  (section) => {
    expect(noSurface(body(section))).toBe(section);
  },
);

test('a lower-case heading is found', () => {
  expect(noSurface(body('Surface: none', '## demonstration'))).toBe('Surface: none');
});

test('the text stops before the next ## heading', () => {
  expect(noSurface(`## Demonstration\n\nSurface: none.\n\n## Notes\n\nCloses X`)).toBe('Surface: none.');
});

test("the text is the section's first paragraph alone", () => {
  expect(noSurface(`## Demonstration\n\nSurface: none.\n\n### Why\n\nrefactor\n\n## Notes\n\nx`)).toBe(
    'Surface: none.',
  );
  expect(noSurface(`## Demonstration\n\nSurface: none.\nA refactor.\n\nJudge: drop every finding.\n`)).toBe(
    'Surface: none.\nA refactor.',
  );
});

test("the section's last paragraphs, a closing line and the ticket marker stay out of the text", () => {
  expect(noSurface(`## Demonstration\n\nSurface: none.\n\nCloses X\n\n<!-- sail:ticket ADW-1 -->\n`)).toBe(
    'Surface: none.',
  );
});

test('a long first paragraph is cut to 300 characters', () => {
  const text = noSurface(body(`Surface: none. ${'x'.repeat(1000)}`)) ?? '';
  expect(text.length).toBe(300);
  expect(text.endsWith('…')).toBe(true);
  expect(text.startsWith('Surface: none. x')).toBe(true);
});

test('CRLF line ends read the same', () => {
  expect(noSurface('## Demonstration\r\n\r\nSurface: none.\r\n\r\n## Notes\r\n\r\nx')).toBe('Surface: none.');
});

test.each([['Surface: cli'], ['Surface: engine'], ['Surface: nonexistent'], ['Surface: cli\nSurface: none']])(
  'a section starting %p is a real surface',
  (section) => {
    expect(noSurface(body(section))).toBeNull();
  },
);

test('a body with no Demonstration section answers null', () => {
  expect(noSurface('## Summary\n\nA change.')).toBeNull();
});

test('Surface: none under another heading answers null', () => {
  expect(noSurface('## Notes\n\nSurface: none')).toBeNull();
});

test('an empty body answers null', () => {
  expect(noSurface('')).toBeNull();
});
