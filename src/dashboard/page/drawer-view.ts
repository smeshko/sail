// The file drawer: one of a call's files, opened from the inspector's files tab, over the right of the page. A markdown
// file comes from the server as HTML it built with every piece of the file escaped (src/dashboard/markdown.ts), and
// any other file as text, escaped here. Closed, the drawer is empty, and the page hides it.
import { html, raw, type SafeHtml } from './html';
import type { Loaded } from './inspector-view';
import type { UiState } from './ui-state';

/** Whether the file at `path` is shown as markdown. */
export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/** The drawer for the file `ui.file`, from `loaded`, or nothing when no file is open. */
export function renderDrawer(ui: UiState, loaded: Loaded<string> | undefined): SafeHtml {
  const file = ui.file;
  if (file === undefined) return html``;
  const body =
    loaded === undefined || loaded.state === 'loading'
      ? html`<div class="code">loading…</div>`
      : loaded.state === 'missing'
        ? html`<div class="code bad">${loaded.message ?? 'this file is not in the run'}</div>`
        : isMarkdown(file.path)
          ? html`<div class="md">${raw(loaded.value)}</div>`
          : html`<pre class="code">${loaded.value}</pre>`;
  return html`<div class="drawer-h"><span><b>${file.name}</b><span class="d">${file.path}</span></span><button class="btn" data-action="close-file" title="close (Esc)">✕</button></div><div class="drawer-b">${body}</div>`;
}
