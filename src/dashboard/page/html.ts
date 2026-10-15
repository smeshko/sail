// The one way the page builds HTML: the `html` tagged template escapes every interpolation, unless it is the tag's own
// `SafeHtml`. Ticket titles, agent messages, outputs, file names, reasons, commands and logs are untrusted, and the
// page renders them with `innerHTML` on the dashboard's own origin, where a script could read every registered run.
// So nothing reaches the markup unescaped, and only an http(s) URL ever becomes a link.
//
// Stub (TASK-001): signatures only.

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

/** `text` with `& < > " '` escaped, safe as element text and inside a quoted attribute. */
export function escapeHtml(text: string): string {
  return text;
}

/** A trusted literal, such as an icon: the only way into the markup besides `html` itself. */
export function raw(_text: string): SafeHtml {
  return new SafeHtml('');
}

/** The tagged template: each interpolation escaped, a `SafeHtml` as it is, an array flattened. */
export function html(strings: TemplateStringsArray, ..._values: readonly Interpolation[]): SafeHtml {
  return new SafeHtml(strings.join(''));
}

/** `parts` rendered as `html` would, with `separator` between them. */
export function join(_parts: readonly Interpolation[], _separator: Interpolation): SafeHtml {
  return new SafeHtml('');
}

/** `url` when it is an absolute http: or https: URL, else undefined: anything else is shown as text, never linked. */
export function safeHref(url: string | undefined): string | undefined {
  return url;
}
