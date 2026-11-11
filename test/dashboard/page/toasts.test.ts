import { describe, expect, test } from 'bun:test';
import { addToast, HINT_MS, removeToast, TOAST_MS, type Toast, UNDO_MS } from '../../../src/dashboard/page/toasts';

const toast = (id: number, kind: 'ok' | 'bad', head = 'poll a / b', text = 'queued'): Toast => ({
  id,
  kind,
  head,
  text,
});

describe('audit 2: overlays behave (ADW-542)', () => {
  test('a hint leaves after 3 s and replaces the hint shown, whatever its words, and leaves the rest', () => {
    const hint = (id: number, head: string): Toast => ({ id, kind: 'hint', head, text: 'needs a queue' });
    expect(HINT_MS).toBe(3000);
    const list = addToast([toast(1, 'bad'), hint(2, 'poll (P)'), toast(3, 'ok')], hint(4, 'open (O)'));
    expect(list.map((each) => each.id)).toEqual([1, 3, 4]);
    expect(addToast(list, toast(5, 'bad')).map((each) => each.id)).toEqual([3, 4, 5]);
  });
});

test('the times are 4 s for a success and 8 s for an undo', () => {
  expect([TOAST_MS, UNDO_MS]).toEqual([4000, 8000]);
});

test('a toast joins the end of the stack', () => {
  expect(addToast([toast(1, 'ok')], toast(2, 'ok')).map((each) => each.id)).toEqual([1, 2]);
});

test('a refusal equal in head and text to one shown replaces it, and a different one stacks', () => {
  const list = [toast(1, 'bad'), toast(2, 'ok')];
  expect(addToast(list, toast(3, 'bad')).map((each) => each.id)).toEqual([2, 3]);
  expect(addToast(list, toast(3, 'bad', 'poll a / b', 'other')).map((each) => each.id)).toEqual([1, 2, 3]);
});

test('a success equal to one shown stacks beside it', () => {
  expect(addToast([toast(1, 'ok')], toast(2, 'ok')).length).toBe(2);
});

test('removing a toast leaves the others, in order', () => {
  expect(removeToast([toast(1, 'ok'), toast(2, 'bad'), toast(3, 'ok')], 2).map((each) => each.id)).toEqual([1, 3]);
});
