// The focused subject: three sources, the one that changed last wins, and a source set to what it holds is no change.
import { expect, test } from 'bun:test';
import type { Subject } from '../../../src/dashboard/page/action-registry';
import { focused, sameSubject, setFocus } from '../../../src/dashboard/page/focus';
import { initialUi } from '../../../src/dashboard/page/ui-state';

const run: Subject = { kind: 'run', repo: 'alpha', runId: 'FAKE-1-x' };
const other: Subject = { kind: 'run', repo: 'alpha', runId: 'FAKE-2-y' };
const item: Subject = { kind: 'item', repo: 'beta', workflow: 'ticket-to-pr', item: 'ticket:FAKE-5' };

test('with no source held there is no focused subject', () => {
  expect(focused(initialUi(0))).toBeUndefined();
});

test('the hover source is the subject while it is the only one held', () => {
  const ui = initialUi(0);
  setFocus(ui, 'hover', run);
  expect(focused(ui)).toEqual(run);
});

test('the cursor source is the subject while it is the only one held', () => {
  const ui = initialUi(0);
  setFocus(ui, 'cursor', item);
  expect(focused(ui)).toEqual(item);
});

test('the open source is the subject while it is the only one held', () => {
  const ui = initialUi(0);
  setFocus(ui, 'open', run);
  expect(focused(ui)).toEqual(run);
});

test('the last changed wins: a cursor after a hover, then a hover of another', () => {
  const ui = initialUi(0);
  setFocus(ui, 'open', run);
  setFocus(ui, 'hover', other);
  expect(focused(ui)).toEqual(other);
  setFocus(ui, 'cursor', item);
  expect(focused(ui)).toEqual(item);
  setFocus(ui, 'hover', run);
  expect(focused(ui)).toEqual(run);
});

test('a source set to what it holds is no change', () => {
  const ui = initialUi(0);
  setFocus(ui, 'cursor', item);
  setFocus(ui, 'hover', run);
  const seq = ui.focus.seq;
  setFocus(ui, 'cursor', { ...item });
  expect(ui.focus.seq).toBe(seq);
  expect(focused(ui)).toEqual(run);
});

test('clearing the latest source gives the next latest', () => {
  const ui = initialUi(0);
  setFocus(ui, 'open', run);
  setFocus(ui, 'hover', item);
  setFocus(ui, 'hover', undefined);
  expect(focused(ui)).toEqual(run);
  setFocus(ui, 'open', undefined);
  expect(focused(ui)).toBeUndefined();
});

test('two subjects are the same only when every field is', () => {
  expect(sameSubject(run, { ...run })).toBe(true);
  expect(sameSubject(run, other)).toBe(false);
  expect(sameSubject(undefined, undefined)).toBe(true);
  expect(sameSubject(run, undefined)).toBe(false);
});
