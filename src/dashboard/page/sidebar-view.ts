// The sidebar: navigation and nothing that grows with activity. Inbox opens needs attention; Active, Queues and History
// each change the list's view, with the count of the rows they list; then every repository as a filter, with a dot for
// its watcher: watching, not watching or broken. It holds no run row, no run menu and no watch button.
import { html, type SafeHtml } from './html';
import type { RailRepo } from './index-model';
import { repoDot, VIEWS, type ViewName } from './list-model';
import { VIEW_LABELS } from './list-view';
import type { UiState } from './ui-state';

const DOT_TITLES = { watching: 'watching', idle: 'not watching', broken: 'broken' } as const;

/** The sidebar. `counts` are what each view lists under the repository filter; `inbox` is the needs-attention count. */
export function renderSidebar(
  repos: readonly RailRepo[],
  counts: Record<ViewName, number>,
  inbox: number,
  ui: UiState,
): SafeHtml {
  return html`<div class="side-nav"><button class="side-ent" type="button" data-action="toggle-attention" aria-pressed="${ui.attention ? 'true' : 'false'}"><span class="nm">Inbox</span><span class="c">${inbox}</span></button>${VIEWS.map(
    (view) =>
      html`<button class="side-ent${ui.view === view ? ' on' : ''}" type="button" data-action="select-view" data-view="${view}"${ui.view === view ? html` aria-current="true"` : ''}><span class="nm">${VIEW_LABELS[view]}</span><span class="c">${counts[view]}</span></button>`,
  )}</div><div class="side-h">repositories</div><div class="side-repos">${repos.map((repo) => {
    const dot = repoDot(repo);
    const on = ui.repoFilter === repo.name;
    return html`<button class="side-repo${on ? ' on' : ''}" type="button" data-action="filter-repo" data-repo="${repo.name}" aria-pressed="${on ? 'true' : 'false'}"><span class="dot dot-${dot}" title="${DOT_TITLES[dot]}"></span><span class="nm">${repo.name}</span></button>`;
  })}</div>`;
}
