import { expect, test } from 'bun:test';
import { renderToasts } from '../../../src/dashboard/page/toast-view';

test('a success is a status with a dismiss button, and a refusal an alert', () => {
  const out = renderToasts([
    { id: 1, kind: 'ok', head: 'copy', text: 'copied x' },
    { id: 2, kind: 'bad', head: 'poll a / b', text: 'no watcher' },
  ]).value;
  expect(out).toContain('<div class="toast ok" role="status" data-toast="1">');
  expect(out).toContain('<div class="toast bad" role="alert" data-toast="2">');
  expect(out).toContain('<span class="toast-head">copy</span> <span class="toast-text">copied x</span>');
  expect(out.match(/data-action="dismiss-toast" data-toast="\d" aria-label="dismiss"/g)).toHaveLength(2);
  expect(out).not.toContain('undo');
});

test('an undoable toast carries an undo button naming it', () => {
  const out = renderToasts([{ id: 7, kind: 'ok', head: 'all clear', text: '3 hidden', undo: true }]).value;
  expect(out).toContain('<button class="btn" data-action="undo-toast" data-toast="7">undo</button>');
});

test('toast text is escaped', () => {
  const out = renderToasts([{ id: 1, kind: 'bad', head: '<b>', text: '"><script>' }]).value;
  expect(out).not.toContain('<script>');
  expect(out).toContain('&lt;b&gt;');
});

test('an empty stack draws nothing', () => {
  expect(renderToasts([]).value).toBe('');
});

test('a toast whose button has a label draws that label in place of undo, a refusal included', () => {
  const out = renderToasts([
    {
      id: 3,
      kind: 'bad',
      head: 'start a run… fixture',
      text: 'sail FAKE-3: x',
      undo: true,
      undoLabel: 'start anyway (--force)',
    },
  ]).value;
  expect(out).toContain('<button class="btn" data-action="undo-toast" data-toast="3">start anyway (--force)</button>');
  expect(out).not.toContain('>undo<');
});
