// Needs attention, drawn: one row per item across every repository, each a button that opens its run, its call and
// the inspector's tab. An item with nothing to open is drawn the same, without the action.
import type { AttentionItem } from './attention';
import { html, type SafeHtml } from './html';

function where(item: AttentionItem): string {
  return [item.repo, item.workflow, item.runId, item.key].filter((part) => part !== undefined).join(' · ');
}

function row(item: AttentionItem): SafeHtml {
  const body = html`<b>${item.title}</b><span class="w">${where(item)}</span>${
    item.detail === '' ? '' : html`<span class="p">${item.detail}</span>`
  }`;
  const { opens } = item;
  if (opens === undefined) return html`<div class="sig sig-${item.kind}">${body}</div>`;
  return html`<button class="sig sig-${item.kind}" data-action="open" data-repo="${opens.repo}" data-run="${opens.runId}"${
    opens.key === undefined ? '' : html` data-key="${opens.key}"`
  }${opens.tab === undefined ? '' : html` data-tab="${opens.tab}"`}>${body}</button>`;
}

/** The list, or a line saying nothing needs attention. */
export function renderAttention(items: readonly AttentionItem[]): SafeHtml {
  return html`<div class="grp-t">needs attention · ${items.length}</div>
${items.length === 0 ? html`<div class="att-empty">nothing needs attention</div>` : items.map(row)}`;
}
