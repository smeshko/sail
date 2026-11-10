// Needs attention, drawn: a button in the top bar with how many items there are, which opens a pane over the page. The
// pane has one row per item across every repository, each a button that opens its run and its call. An item with
// nothing to open is drawn the same, without the action. A click outside the pane closes it. While the list has items,
// the pane's header has an all clear button.
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
  }>${body}</button>`;
}

/** The button with its count, and while `open` the pane: the list, or a line saying nothing needs attention. */
export function renderAttention(items: readonly AttentionItem[], open: boolean): SafeHtml {
  const button = html`<button class="btn att-btn${open ? ' on' : ''}" type="button" data-action="toggle-attention" aria-expanded="${open ? 'true' : 'false'}" title="needs attention (a)">⚑ needs attention${
    items.length === 0 ? '' : html`<span class="badge">${items.length}</span>`
  }</button>`;
  if (!open) return button;
  return html`${button}<div class="att-scrim" data-action="toggle-attention"></div><div class="att-pane"><div class="rail-h"><span>needs attention</span><span class="c">${items.length}</span>${
    items.length === 0
      ? ''
      : html`<button class="btn att-clear" type="button" data-action="clear-attention">all clear</button>`
  }</div><div class="att-list">${
    items.length === 0 ? html`<div class="att-empty">nothing needs attention</div>` : items.map(row)
  }</div></div>`;
}
