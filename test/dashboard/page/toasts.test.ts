import { expect, test } from 'bun:test';
import { addToast, removeToast, TOAST_MS, type Toast, UNDO_MS } from '../../../src/dashboard/page/toasts';

const toast = (id: number, kind: 'ok' | 'bad', head = 'poll a / b', text = 'queued'): Toast => ({
  id,
  kind,
  head,
  text,
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
