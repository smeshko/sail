import { describe, expect, test } from 'bun:test';
import { namedView, renderDialog } from '../../../src/dashboard/page/dialog-view';

describe('audit 2: overlays behave (ADW-542)', () => {
  const view = {
    title: 'restart FAKE-1-01ABC',
    lines: ['moves its run directory to /m/FAKE-1-01ABC'],
    verb: 'restart',
  };

  test('a run named by its key keeps its title and full id for a quiet line, and its lines as they were', () => {
    const named = namedView(view, 'FAKE-1-01ABC', { key: 'FAKE-1', title: 'Fix <it>' });
    expect(named).toEqual({ ...view, title: 'restart FAKE-1', about: { title: 'Fix <it>', id: 'FAKE-1-01ABC' } });
    expect(renderDialog(named).value).toStartWith(
      '<h2 id="dialog-title">restart FAKE-1</h2><p class="dlg-sub"><span class="dlg-about">Fix &lt;it&gt;</span><span class="dlg-id">FAKE-1-01ABC</span></p><ul class="dlg-lines">',
    );
  });

  test('a run with no short name is left as it was, and one with no title shows its id alone', () => {
    expect(namedView(view, 'FAKE-1-01ABC', undefined)).toBe(view);
    const bare = renderDialog(namedView(view, 'FAKE-1-01ABC', { key: '#12' })).value;
    expect(bare).toContain(
      '<h2 id="dialog-title">restart #12</h2><p class="dlg-sub"><span class="dlg-id">FAKE-1-01ABC</span></p>',
    );
  });
});

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

test('the dialog draws a field per asked parameter, the first focused, and the refusal beside them', () => {
  const view = { title: 'restart R1', lines: ['runs again: s'], verb: 'restart' };
  const fields = [
    { name: 'stage', dom: 'stage', label: 'from', type: 'choice', options: [{ value: 'a' }, { value: 'b' }] },
    { name: 'raise', dom: 'raise', label: 'raise $', type: 'number', min: 0.01 },
  ] as const;
  const out = renderDialog(view, { fields, values: { stage: 'b', raise: '0.5' }, error: 'give <it>' }).value;
  expect(out).toBe(
    '<div id="dialog-body"><h2 id="dialog-title">restart R1</h2><div class="dlg-fields"><label class="lbl">from <select name="stage" autofocus><option value="a">a</option><option value="b" selected>b</option></select></label><label class="lbl">raise $ <input class="num" type="number" name="raise" min="0.01" step="any" value="0.5"></label><span class="dlg-bad" role="alert">give &lt;it&gt;</span></div><ul class="dlg-lines"><li>runs again: s</li></ul></div><div class="dlg-acts"><button class="btn primary" data-action="dialog-confirm">restart</button><button class="btn" data-action="dialog-cancel">cancel</button></div>',
  );
  expect(renderDialog(view, { fields, values: {} }).value).not.toContain('dlg-bad');
  expect(renderDialog(view, { fields: [], values: {} }).value).toBe(renderDialog(view).value);
});

test('a dialog with a text draws it preformatted under its lines, escaped, with its white space kept', () => {
  const view = {
    title: 'start',
    lines: ['stops after spec'],
    text: 'a@1 on X: <T>\n  forced    designation',
    verb: 'start',
  };
  const out = renderDialog(view).value;
  expect(out).toContain(
    '<ul class="dlg-lines"><li>stops after spec</li></ul><pre class="dlg-pre">a@1 on X: &lt;T&gt;\n  forced    designation</pre><div class="dlg-acts">',
  );
  expect(renderDialog({ ...view, text: undefined }).value).not.toContain('dlg-pre');
});
