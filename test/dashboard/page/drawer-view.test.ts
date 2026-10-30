// The file drawer: nothing while no file is open, then the file's name and path with a way to close, and its body: the
// server's markdown HTML as it came, any other file escaped, or loading, or why it isn't there.
import { expect, test } from 'bun:test';
import { isMarkdown, renderDrawer } from '../../../src/dashboard/page/drawer-view';
import { initialUi, type UiState } from '../../../src/dashboard/page/ui-state';

const ui = (file?: UiState['file']): UiState => ({ ...initialUi(0), ...(file === undefined ? {} : { file }) });
const plan = { name: 'plan.md', path: '02-plan/call-1/plan.md' };

test('a markdown path is .md or .markdown, in any case', () => {
  expect(['a.md', 'b.MARKDOWN', 'c.txt', 'md', 'd.md.json'].map(isMarkdown)).toEqual([true, true, false, false, false]);
});

test('closed, the drawer is empty; open, it has the name, the path and a close button, and says loading', () => {
  expect(renderDrawer(ui(), { state: 'loaded', value: 'x' }).value).toBe('');
  expect(renderDrawer(ui(plan), { state: 'loading' }).value).toBe(
    '<div class="drawer-h"><span><b>plan.md</b><span class="d">02-plan/call-1/plan.md</span></span><button class="btn" data-action="close-file" title="close (Esc)">✕</button></div><div class="drawer-b"><div class="code">loading…</div></div>',
  );
  expect(renderDrawer(ui(plan), undefined).value).toContain('loading…');
});

test("markdown is the server's HTML as it came, any other file is escaped text, and a missing one says so", () => {
  expect(renderDrawer(ui(plan), { state: 'loaded', value: '<h1>Plan</h1>' }).value).toContain(
    '<div class="drawer-b"><div class="md"><h1>Plan</h1></div></div>',
  );
  const json = { name: 'ticket.json', path: '00-intake/call-1/out/ticket.json' };
  expect(renderDrawer(ui(json), { state: 'loaded', value: '{"a":"<b>"}' }).value).toContain(
    '<pre class="code">{&quot;a&quot;:&quot;&lt;b&gt;&quot;}</pre>',
  );
  expect(renderDrawer(ui(json), { state: 'missing' }).value).toContain(
    '<div class="code bad">this file is not in the run</div>',
  );
});
