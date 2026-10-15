// Needs attention, drawn: one row per item across every repository, each a button that opens its run, its call and
// the inspector's tab. An item with nothing to open is drawn the same, without the action.
//
// Stub (TASK-006): draws nothing.
import type { AttentionItem } from './attention';
import { html, type SafeHtml } from './html';

/** The list, or a line saying nothing needs attention. */
export function renderAttention(_items: readonly AttentionItem[]): SafeHtml {
  return html``;
}
