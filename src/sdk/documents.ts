// Documents: a file an agent step completes in place. The engine renders its template into `$STAGE_OUT` before the
// session, and runs its validators on what the session left, after. A validator is a pure function over the parsed
// document: it reports problems, and derives facts the engine records in `result.json`, never asking the model for
// them. The engine does the parsing, because the SDK can use neither Bun nor the engine.

/** A fact a validator derives from a document: what `result.json`'s `derived` can hold. */
export type DerivedValue = number | string | boolean | readonly (number | string | boolean)[];

/** A list item at the top level of its list. `checked` is set only for a task item: `- [ ]` or `- [x]`. */
export interface DocumentItem {
  readonly checked?: boolean;
}

/** A heading: its text, trimmed, and its level, 1 for `#`. */
export interface DocumentHeading {
  readonly text: string;
  readonly level: number;
}

/** One heading's section: the top-level list items from it up to the next heading of the same or a higher level. */
export interface DocumentSection {
  readonly heading: string;
  readonly level: number;
  readonly items: readonly DocumentItem[];
}

/** A produced document as the engine parsed it, which every validator is handed. */
export interface DocumentContent {
  /** The file's name in `$STAGE_OUT`. */
  readonly name: string;
  readonly text: string;
  /** The names of the placeholders its template held, each once, in order. */
  readonly placeholders: readonly string[];
  /** Every heading, in order. Fenced code holds none. */
  readonly headings: readonly DocumentHeading[];
  /** One per heading, in order. */
  readonly sections: readonly DocumentSection[];
  /** Every top-level list item of the document, in order. */
  readonly items: readonly DocumentItem[];
}

/** What a validator found: each problem as one plain sentence, and the facts it derived, by key. */
export interface Verdict {
  readonly problems: readonly string[];
  readonly derived?: Readonly<Record<string, DerivedValue>>;
}

/** A check of a document. A repository may write its own. */
export interface Validator {
  /** The check's label, as `result.json` and the `file:validated` event list it. */
  readonly check: string;
  /** The keys of every fact it may derive. Two validators of one step can't derive the same key. */
  readonly derives: readonly string[];
  validate(document: DocumentContent): Verdict;
}

/** A file an agent step completes in place: its template, rendered before the session, and its validators. */
export interface Document {
  readonly kind: 'document';
  /** The template, relative to the stage directory. */
  readonly template: string;
  readonly validators: readonly Validator[];
}

/** The bounds a count must keep. Each is a whole number of 0 or more, and `min` is no more than `max`. */
export interface Bounds {
  readonly min?: number;
  readonly max?: number;
}

/** Bounds, and the key the count is derived under. */
export interface CountOptions extends Bounds {
  readonly as?: string;
}

/**
 * Declares a document in an agent step's `produces`: `template` is rendered into `$STAGE_OUT` before the session,
 * with the step's bindings filled and the template's `{{name: hint}}` placeholders left for the agent, and `validators` check
 * what the session left there.
 */
export function doc(template: string, validators: readonly Validator[] = []): Document {
  if (typeof template !== 'string' || template.trim() === '') {
    throw new Error('doc(): the template must be a path, relative to the stage directory');
  }
  if (!Array.isArray(validators)) throw new Error(`doc('${template}'): the validators must be a list`);
  validators.forEach((validator: Partial<Validator> | null, index) => {
    const at = `doc('${template}'): validator ${index}`;
    if (typeof validator !== 'object' || validator === null) throw new Error(`${at} is not a validator`);
    if (typeof validator.check !== 'string' || validator.check === '') throw new Error(`${at} has no check label`);
    const derives = validator.derives;
    if (!Array.isArray(derives) || !derives.every((key) => typeof key === 'string' && key !== '')) {
      throw new Error(`${at} must list the keys it derives`);
    }
    if (typeof validator.validate !== 'function') throw new Error(`${at} has no validate function`);
  });
  return Object.freeze({ kind: 'document', template, validators: Object.freeze([...validators]) });
}

/** Checks `bounds` for `owner`, and returns their part of its label. */
function boundsOf(owner: string, bounds: Bounds): string[] {
  const { min, max } = bounds;
  for (const [name, value] of [
    ['min', min],
    ['max', max],
  ] as const) {
    if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
      throw new Error(`${owner}: ${name} must be a whole number of 0 or more: ${value}`);
    }
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`${owner}: min ${min} is more than max ${max}`);
  }
  return [...(min === undefined ? [] : [`min ${min}`]), ...(max === undefined ? [] : [`max ${max}`])];
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** What is wrong with `count` of what `of` names, against `bounds`. */
function outside(of: string, count: number, noun: string, { min, max }: Bounds): string[] {
  if (min !== undefined && count < min) return [`${of} ${plural(count, noun)}, fewer than ${min}`];
  if (max !== undefined && count > max) return [`${of} ${plural(count, noun)}, more than ${max}`];
  return [];
}

/** The key a derived fact goes under, checked. */
function keyOf(owner: string, as: unknown): string {
  if (typeof as !== 'string' || as === '') throw new Error(`${owner}: as must be a key of one or more characters`);
  return as;
}

/** A section's words in camelCase: `Tasks` gives `tasks`, `Out of scope` gives `outOfScope`. */
function camelCase(words: string): string {
  const [first = '', ...rest] = words.split(/[^A-Za-z0-9]+/).filter((word) => word !== '');
  return first.toLowerCase() + rest.map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase()).join('');
}

/** Passes when every name is a heading's text, at any level. */
export function hasSections(...names: string[]): Validator {
  if (names.length === 0) throw new Error('hasSections(): name at least one section');
  for (const name of names) {
    if (typeof name !== 'string' || name.trim() === '') throw new Error('hasSections(): a section name is empty');
  }
  return {
    check: `hasSections(${names.join(', ')})`,
    derives: [],
    validate: (document) => ({
      problems: names
        .filter((name) => !document.headings.some((heading) => heading.text === name.trim()))
        .map((name) => `has no '${name}' section`),
    }),
  };
}

/** A placeholder's name as a problem may quote it: a path, as the renderer reads a variable's. */
const PLACEHOLDER_NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/** Tags whose bodies hold a colon, named from the last opener before that colon. */
export function* placeholderTags(text: string): Generator<{ from: number; name: string }> {
  for (let start = text.indexOf('{{'); start !== -1; ) {
    const close = text.indexOf('}}', start + 2);
    if (close === -1) break;
    const colon = text.slice(start + 2, close).lastIndexOf(':');
    if (colon !== -1) {
      const from = text.lastIndexOf('{{', start + colon);
      const body = text.slice(from + 2, close);
      yield { from, name: body.slice(0, body.indexOf(':')).trim() };
    }
    start = text.indexOf('{{', close + 2);
  }
}

/** The raw template's placeholder names, each once, in order, including tags in code and untaken branches. */
export function placeholderNames(text: string): string[] {
  return [...new Set([...placeholderTags(text)].map(({ name }) => name))];
}

type Range = readonly [number, number];

/** Sorted code and untrusted-input ranges, computed with forward scans and a linear merge. */
function skippedRanges(text: string): Range[] {
  const fences: Range[] = [];
  let fence: { from: number; char: string; length: number } | undefined;
  for (const match of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\n]*)/gm)) {
    const run = match[1] ?? '';
    if (fence === undefined) {
      fence = { from: match.index, char: run[0] ?? '', length: run.length };
    } else if (run[0] === fence.char && run.length >= fence.length && (match[2] ?? '').trim() === '') {
      fences.push([fence.from, match.index + match[0].length]);
      fence = undefined;
    }
  }
  if (fence !== undefined) fences.push([fence.from, text.length]);

  const code: Range[] = [];
  // A brace tag is indivisible: its hint's backticks cannot close a code span opened in prose. Mask only
  // those backticks, preserving offsets and allowing a complete tag to remain inside agent-written code.
  const inlineText = text.replace(/\{\{[\s\S]*?\}\}/g, (tag) => tag.replace(/`/g, ' '));
  // Pair each backtick run with the next of exactly its length, in each region outside fences. Looking up the
  // partner avoids rescanning the remainder of the text for every unmatched opening run.
  const inline = (start: number, end: number) => {
    const runs = [...inlineText.slice(start, end).matchAll(/`+/g)];
    const next = new Map<number, number>();
    const partners: (number | undefined)[] = [];
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const length = runs[index]?.[0].length ?? 0;
      partners[index] = next.get(length);
      next.set(length, index);
    }
    for (let index = 0; index < runs.length; index += 1) {
      const partner = partners[index];
      if (partner === undefined) continue;
      const opening = runs[index];
      const closing = runs[partner];
      if (opening !== undefined && closing !== undefined) {
        code.push([start + opening.index, start + closing.index + closing[0].length]);
      }
      index = partner;
    }
  };
  let start = 0;
  for (const range of fences) {
    inline(start, range[0]);
    code.push(range);
    start = range[1];
  }
  inline(start, text.length);

  const untrusted: Range[] = [];
  const opener = /<untrusted-input(?=\s|>)/g;
  for (let match = opener.exec(text); match !== null; match = opener.exec(text)) {
    const close = text.indexOf('</untrusted-input>', opener.lastIndex);
    if (close === -1) break;
    const end = close + '</untrusted-input>'.length;
    untrusted.push([match.index, end]);
    opener.lastIndex = end;
  }
  const ranges: Range[] = [];
  let left = 0;
  let right = 0;
  while (left < code.length || right < untrusted.length) {
    const a = code[left];
    const b = untrusted[right];
    const range = a !== undefined && (b === undefined || a[0] <= b[0]) ? code[left++] : untrusted[right++];
    if (range === undefined) continue;
    const previous = ranges.at(-1);
    if (previous !== undefined && range[0] <= previous[1]) {
      ranges[ranges.length - 1] = [previous[0], Math.max(previous[1], range[1])];
    } else ranges.push(range);
  }
  return ranges;
}

/** Passes when none of the template's placeholders is left outside untrusted input, fenced code or inline code. */
export function noPlaceholders(): Validator {
  return {
    check: 'noPlaceholders',
    derives: [],
    validate: ({ text, placeholders }) => {
      const names = new Set(placeholders);
      const ranges = skippedRanges(text);
      let range = 0;
      const problems: string[] = [];
      // The line is counted on from the last tag, and `newline` is the first not yet counted, so each newline is found
      // once however many tags the text holds.
      let line = 1;
      let newline = text.indexOf('\n');
      for (const { from, name } of placeholderTags(text)) {
        while (ranges[range] !== undefined && (ranges[range]?.[1] ?? 0) <= from) range += 1;
        if (from >= (ranges[range]?.[0] ?? Infinity)) continue;
        if (names.has(name)) {
          for (; newline !== -1 && newline < from; newline = text.indexOf('\n', newline + 1)) line += 1;
          // The problem goes into the corrective prompt, outside any untrusted wrapper, so it names the placeholder
          // only when the name is one a template author writes: never the text of a ticket the document quotes.
          problems.push(
            PLACEHOLDER_NAME.test(name) && name.length <= 64
              ? `line ${line} still holds the placeholder {{${name}: …}}`
              : `line ${line} still holds a placeholder`,
          );
        }
      }
      return { problems };
    },
  };
}

/**
 * Counts the top-level list items of `section`, from its heading to the next heading of the same or a higher level,
 * and passes when the section exists and the count is within the bounds. The count is derived under `as`, by default
 * the section's words in camelCase.
 */
export function countItems(section: string, options: CountOptions = {}): Validator {
  if (typeof section !== 'string' || section.trim() === '') throw new Error('countItems(): name the section');
  const owner = `countItems(${section})`;
  const label = boundsOf(owner, options);
  const key = keyOf(owner, options.as ?? (camelCase(section) || undefined));
  const name = section.trim();
  return {
    check: `countItems(${[name, ...label].join(', ')})`,
    derives: [key],
    validate: (document) => {
      const found = document.sections.find((each) => each.heading === name);
      if (found === undefined) return { problems: [`has no '${name}' section`] };
      const count = found.items.length;
      return { problems: outside(`'${name}' has`, count, 'item', options), derived: { [key]: count } };
    },
  };
}

/**
 * Counts the document's top-level task items, `- [ ]` and `- [x]`, and passes when the count is within the bounds.
 * The count is derived under `as`, `checklist` by default, and the checked ones under `as` + `Done`.
 */
export function checklist(options: CountOptions = {}): Validator {
  const label = boundsOf('checklist()', options);
  const key = keyOf('checklist()', options.as ?? 'checklist');
  return {
    check: label.length === 0 ? 'checklist' : `checklist(${label.join(', ')})`,
    derives: [key, `${key}Done`],
    validate: (document) => {
      const tasks = document.items.filter((item) => typeof item.checked === 'boolean');
      const done = tasks.filter((item) => item.checked === true).length;
      return {
        problems: outside('has', tasks.length, 'checklist item', options),
        derived: { [key]: tasks.length, [`${key}Done`]: done },
      };
    },
  };
}
