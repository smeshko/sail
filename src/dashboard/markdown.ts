// A run's markdown file as HTML the page can show as it is. Bun parses it, and every element is built here: text is
// escaped, raw HTML in the file is shown as text, only an http(s) URL becomes a link, and an image is its alt text and
// its URL, never fetched. So nothing the file holds reaches the page's markup as markup.
import { escapeHtml, safeHref } from './page/html';

const ALIGNS = new Set(['left', 'center', 'right']);

const cell = (tag: 'th' | 'td') => (children: string, meta?: { align?: string }) => {
  const align = meta?.align;
  return align !== undefined && ALIGNS.has(align)
    ? `<${tag} style="text-align:${align}">${children}</${tag}>`
    : `<${tag}>${children}</${tag}>`;
};

const wrap = (tag: string) => (children: string) => `<${tag}>${children}</${tag}>`;

/** `text`, markdown, as escaped HTML. */
export function renderMarkdown(text: string): string {
  return Bun.markdown.render(text, {
    text: (children) => escapeHtml(children),
    html: (children) => children,
    heading: (children, meta) => {
      const level = Math.min(6, Math.max(1, Math.trunc(meta.level) || 1));
      return `<h${level}>${children}</h${level}>\n`;
    },
    paragraph: (children) => `<p>${children}</p>\n`,
    blockquote: wrap('blockquote'),
    code: (children, meta) => {
      const language = meta?.language === undefined || meta.language === '' ? undefined : meta.language;
      return `<pre class="md-code"${language === undefined ? '' : ` data-lang="${escapeHtml(language)}"`}><code>${children}</code></pre>\n`;
    },
    list: (children, meta) => {
      if (!meta.ordered) return `<ul>${children}</ul>\n`;
      const start = meta.start ?? 1;
      return `<ol${Number.isInteger(start) && start !== 1 ? ` start="${start}"` : ''}>${children}</ol>\n`;
    },
    listItem: (children, meta) =>
      typeof meta.checked === 'boolean'
        ? `<li class="task"><input type="checkbox" disabled${meta.checked ? ' checked' : ''}> ${children}</li>`
        : `<li>${children}</li>`,
    hr: () => '<hr>\n',
    table: (children) => `<table>${children}</table>\n`,
    thead: wrap('thead'),
    tbody: wrap('tbody'),
    tr: wrap('tr'),
    th: cell('th'),
    td: cell('td'),
    strong: wrap('strong'),
    emphasis: wrap('em'),
    strikethrough: wrap('del'),
    codespan: wrap('code'),
    link: (children, meta) => {
      const href = safeHref(meta.href);
      return href === undefined
        ? children
        : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${children}</a>`;
    },
    image: (children, meta) => {
      const src = meta.src ?? '';
      return `<span class="md-img">[${children}${src === '' ? '' : ` · ${escapeHtml(src)}`}]</span>`;
    },
  });
}
