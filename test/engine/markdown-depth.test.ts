// markdownDepth: a linear upper bound on how deep a markdown text nests its list items and block quotes.
import { expect, test } from 'bun:test';
import { MAX_MARKDOWN_DEPTH, markdownDepth } from '../../src/engine/markdown-depth';

test('prose and headings nest nothing', () => {
  expect(markdownDepth('')).toBe(0);
  expect(markdownDepth('# Title\n\nSome prose, with - a dash.\n')).toBe(0);
  expect(MAX_MARKDOWN_DEPTH).toBe(64);
});

test('each list marker and block quote in a row opens a level', () => {
  expect(markdownDepth('- a')).toBe(1);
  expect(markdownDepth('- - - x')).toBe(3);
  expect(markdownDepth('> > - 1. x')).toBe(4);
  expect(markdownDepth('>>x')).toBe(2);
});

test('every bullet and ordered marker counts', () => {
  expect(markdownDepth('1) x')).toBe(1);
  expect(markdownDepth('+ x')).toBe(1);
  expect(markdownDepth('* x')).toBe(1);
  expect(markdownDepth('12. x')).toBe(1);
  expect(markdownDepth('-\n')).toBe(1);
});

test('a marker with nothing after it to open a list does not count', () => {
  expect(markdownDepth('-x')).toBe(0);
  expect(markdownDepth('1.x')).toBe(0);
  expect(markdownDepth('1234567890. x')).toBe(0);
});

test('indentation counts two columns per level, and a tab four', () => {
  expect(markdownDepth('- a\n  - b\n    - c')).toBe(3);
  expect(markdownDepth('\t\tx')).toBe(4);
  expect(markdownDepth('\t- x')).toBe(3);
});

test("a text's depth is its deepest line's", () => {
  expect(markdownDepth('- a\n- - - b\n- c\n')).toBe(3);
  expect(markdownDepth('- a\r\n- - b\r\n')).toBe(2);
});

test('1 MiB of list markers is measured in under a second', () => {
  const text = '- '.repeat(512 * 1024);
  const started = performance.now();
  expect(markdownDepth(text)).toBe(512 * 1024);
  expect(performance.now() - started).toBeLessThan(1000);
});
