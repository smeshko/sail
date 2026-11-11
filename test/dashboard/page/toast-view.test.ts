import { describe, expect, test } from 'bun:test';
import { renderToasts } from '../../../src/dashboard/page/toast-view';

describe('audit 2: overlays behave (ADW-542)', () => {
  test('the stack shows the newest three under a line counting the rest, and a hint is a neutral status', () => {
    const toasts = [1, 2, 3, 4, 5].map((id) => ({ id, kind: 'bad' as const, head: `stop R${id}`, text: 'no' }));
    const out = renderToasts(toasts).value;
    expect(out).toStartWith('<div class="toast-more">+2 more</div><div class="toast bad" role="alert" data-toast="3">');
    expect(out.match(/class="toast bad"/g)).toHaveLength(3);
    expect(renderToasts(toasts.slice(2)).value).not.toContain('toast-more');
    const hint = renderToasts([{ id: 9, kind: 'hint', head: 'poll (P)', text: 'needs a queue' }]).value;
    expect(hint).toContain('<div class="toast quiet" role="status" data-toast="9">');
  });
});

test('a success is a status with a ✕ dismiss button, and a refusal an alert; each reads head — text', () => {
  const out = renderToasts([
    { id: 1, kind: 'ok', head: 'copy', text: 'copied x' },
    { id: 2, kind: 'bad', head: 'poll a / b', text: 'no watcher' },
  ]).value;
  expect(out).toContain('<div class="toast ok" role="status" data-toast="1">');
  expect(out).toContain('<div class="toast bad" role="alert" data-toast="2">');
  expect(out).toContain('<span class="toast-head">copy</span> — <span class="toast-text">copied x</span>');
  expect(
    out.match(/data-action="dismiss-toast" data-toast="\d" aria-label="dismiss" title="dismiss">✕</g),
  ).toHaveLength(2);
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
