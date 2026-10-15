// The one way the page builds HTML: the `html` tagged template escapes every interpolation, unless it is the tag's own
// `SafeHtml`. Ticket titles, agent messages, outputs, file names, reasons, commands and logs are untrusted, and the
// page renders them with `innerHTML` on the dashboard's own origin, where a script could read every registered run.
// So nothing reaches the markup unescaped, and only an http(s) URL ever becomes a link.

/** Markup the tag made, or a trusted literal: it goes into another `html` as it is. */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

/** What an `html` interpolation may be. `null`, `undefined` and `false` render nothing, and an array its items. */
export type Interpolation = SafeHtml | string | number | boolean | null | undefined | readonly Interpolation[];

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with `& < > " '` escaped, safe as element text and inside a quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** A trusted literal, such as an icon: the only way into the markup besides `html` itself. */
export function raw(text: string): SafeHtml {
  return new SafeHtml(text);
}

/**
 * Any value as text, never throwing: a primitive as `String()` gives it, anything else as its JSON. Run files are parsed
 * JSON nothing re-validates, and `String()` throws on an object whose `toString` isn't a function (review R1-4).
 */
export function text(value: unknown): string {
  if (typeof value !== 'object' || value === null) return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function render(value: Interpolation): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(text(value));
}

/** The tagged template: each interpolation escaped, a `SafeHtml` as it is, an array flattened. */
export function html(strings: TemplateStringsArray, ...values: readonly Interpolation[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? '');
  });
  return new SafeHtml(out);
}

/** `parts` rendered as `html` would, with `separator` between them. */
export function join(parts: readonly Interpolation[], separator: Interpolation): SafeHtml {
  return new SafeHtml(parts.map(render).join(render(separator)));
}

/** `url` when it is an absolute http: or https: URL, else undefined: anything else is shown as text, never linked. */
export function safeHref(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
