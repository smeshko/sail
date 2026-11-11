// The sidebar: four entries with counts, then a filter button per repository with its dot, and no run row or menu.
import { expect, test } from 'bun:test';
import type { ListRepo } from '../../../src/dashboard/page/index-model';
import { renderSidebar } from '../../../src/dashboard/page/sidebar-view';
import { initialUi } from '../../../src/dashboard/page/ui-state';

const repo = (name: string, extra: Partial<ListRepo> = {}): ListRepo => ({
  name,
  remote: null,
  live: false,
  runs: [],
  workflows: [],
  ...extra,
});
const repos = [repo('alpha', { watching: ['w'] }), repo('beta'), repo('<i>gamma</i>', { problem: 'broken clone' })];
const counts = { inbox: 5, active: 8, queues: 2, history: 36 };
const draw = (fields = {}) => renderSidebar(repos, counts, { ...initialUi(0), ...fields }).value;

test('the sidebar draws Inbox, Active, Queues and History with their counts', () => {
  const entries = [...draw().matchAll(/<span class="nm">(\w+)<\/span><span class="c">(\d+)<\/span><\/button>/g)].map(
    ([, name, n]) => `${name} ${n}`,
  );
  expect(entries.slice(0, 4)).toEqual(['Inbox 5', 'Active 8', 'Queues 2', 'History 36']);
  expect(draw()).not.toContain('toggle-attention');
  const views = [...draw().matchAll(/data-action="select-view" data-view="(\w+)"/g)].map(([, view]) => view);
  expect(views).toEqual(['inbox', 'active', 'queues', 'history']);
  expect(draw()).toMatch(/data-view="inbox"[^>]*><span class="nm">Inbox<\/span><span class="c">5<\/span>/);
});

test('the open view is marked current and an unopened one is not', () => {
  const markup = draw({ view: 'history' });
  expect(markup.match(/aria-current="true"/g)).toHaveLength(1);
  expect(markup).toMatch(/data-view="history" aria-current="true"/);
});

test('each repository is one filter button with a dot that says watching, not watching or broken', () => {
  const markup = draw({ repoFilter: 'beta' });
  expect(markup).toContain(
    '<button class="side-repo" type="button" data-action="filter-repo" data-repo="alpha" aria-pressed="false"><span class="dot dot-watching" title="watching"></span>',
  );
  expect(markup).toContain('data-repo="beta" aria-pressed="true"><span class="dot dot-idle" title="not watching">');
  expect(markup).toContain('<span class="dot dot-broken" title="broken">');
  expect(markup.match(/data-action="filter-repo"/g)).toHaveLength(3);
});

test('the sidebar holds no run row, run menu or watch button, and escapes a repository name', () => {
  const markup = draw();
  for (const gone of ['select-run', 'run-menu', 'watch-set', 'select-queue']) expect(markup).not.toContain(gone);
  expect(markup).not.toContain('<i>');
  expect(markup).toContain('&lt;i&gt;gamma&lt;/i&gt;');
});
