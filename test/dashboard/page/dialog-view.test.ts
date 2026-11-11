import { expect, test } from 'bun:test';
import { renderDialog } from '../../../src/dashboard/page/dialog-view';

test('the dialog has the title, one li per line, the verb as the focused primary button, and cancel', () => {
  const out = renderDialog({ title: 'clean R1', lines: ['removes a', 'removes b'], verb: 'clean' }).value;
  expect(out).toBe(
    '<h2 id="dialog-title">clean R1</h2><ul class="dlg-lines"><li>removes a</li><li>removes b</li></ul><div class="dlg-acts"><button class="btn primary" data-action="dialog-confirm" autofocus>clean</button><button class="btn" data-action="dialog-cancel">cancel</button></div>',
  );
});

test('a title and lines are escaped, and no line draws an empty list item', () => {
  const out = renderDialog({ title: '<b>x</b>', lines: ['"><script>'], verb: 'drop' }).value;
  expect(out).not.toContain('<script>');
  expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
  expect(renderDialog({ title: 't', lines: [], verb: 'v' }).value).not.toContain('<li>');
});
