// splitDescription(): a ticket's description split into the request and its acceptance criteria, the list under an
// "Acceptance criteria" heading. Only what became a criterion leaves the request, so no line of a description is lost.
// A pure function: this module imports nothing.

export interface SplitDescription {
  /** The description without the heading and the criteria's lines. */
  request: string;
  /** Each top-level list item of the section, in order, without its marker or checkbox. */
  criteria: string[];
}

// Whitespace is whatever `\s` takes, a no-break space included: a description pasted from rich text holds them. A
// line never holds its own ending, so `\s` can't run past it.

/** The heading's text, as a pattern: its two words, with whitespace between. */
const TEXT = 'acceptance\\s+criteria';

/** An ATX heading of any text: `## Notes`. Its level is how many `#` it has. */
const ATX = /^ {0,3}(#{1,6})(?:\s|$)/;
/** The ATX form of the heading: `### Acceptance criteria:`. */
const ATX_HEADING = new RegExp(`^ {0,3}(#{1,6})\\s+${TEXT}\\s*:?\\s*$`, 'i');
/** A line that is bold and nothing else: `**Notes**`, `__Notes:__`. */
const BOLD = /^\s*(\*\*|__)\S(?:.*\S)?\1:?\s*$/s;
/** The bold form of the heading: `**Acceptance criteria**`, with a colon inside or after. */
const BOLD_HEADING = new RegExp(`^\\s*(\\*\\*|__)${TEXT}:?\\1:?\\s*$`, 'i');
/** The plain form of the heading, which needs its colon: `Acceptance criteria:`. */
const PLAIN_HEADING = new RegExp(`^\\s*${TEXT}:\\s*$`, 'i');
/** A list item, whose text is the capture: `- text`, `* text`, `+ text`, `1. text`, `1) text`. */
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(\S.*)$/s;
/** A task checkbox at the start of an item's text: `[ ] `, `[x] `. */
const CHECKBOX = /^\[[ xX]\]\s+(?=\S)/;
/** A code fence's line, whose marker is the capture: three or more backticks with no backtick after, or tildes. */
const FENCE = /^\s*(`{3,}(?=[^`]*$)|~{3,})/;
/** A list marker alone on its line: an item whose text starts below it. It is no criterion, having no text. */
const BARE = /^\s*(?:[-*+]|\d+[.)])\s*$/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** How wide `text` is in columns, a tab reaching the next multiple of four, as Markdown counts an indent. */
function columnsOf(text: string): number {
  let columns = 0;
  for (const char of text) columns += char === '\t' ? 4 - (columns % 4) : 1;
  return columns;
}

/**
 * Which lines are code: those inside a fence, with the line that closes it. A fence is read where Bun's Markdown
 * parser reads one, which takes the list items around it:
 *
 * - It opens on a line indented less than four columns past the block that holds it, or right after an item's marker.
 *   That line is code unless it is the item's own, which stays an item. Indented further, backticks are indented code.
 * - It closes on its marker alone, at least as long as the one that opened it and indented less than four columns
 *   past its block.
 * - It ends with the item that holds it, at the first line that falls short of the item's text. Its own marker on that
 *   line still closes it. Any other line starts anew.
 *
 * An item here is a marker with its text, or a marker alone on its line, whose text may start on the next line. Only
 * the plain cases of a marker alone are followed: Markdown's rules for one under a paragraph go further than this.
 */
function fenced(lines: readonly string[]): boolean[] {
  /** The column each open item's text starts at, innermost last: what a line must reach to be inside the item. */
  const items: number[] = [];
  /** The open fence: its marker, and the column of the block that holds it. */
  let fence: { marker: string; base: number } | undefined;
  /** Whether the line above was a paragraph's: plain text right under one goes on with it, however little indented. */
  let paragraph = false;
  /** Whether the line above was a marker alone: a blank line right under one ends its item, which stays empty. */
  let bare = false;

  return lines.map((line) => {
    const underBare = bare;
    bare = false;
    if (line.trim() === '') {
      if (underBare) items.pop();
      paragraph = false;
      return fence !== undefined;
    }
    const indent = columnsOf(line.slice(0, indentOf(line)));
    const held = items.filter((column) => column <= indent);
    if (fence !== undefined) {
      const marker = FENCE.exec(line)?.[1];
      const same = marker !== undefined && marker[0] === fence.marker[0] && marker.length >= fence.marker.length;
      const closes = same && line.trim() === marker;
      if (indent >= fence.base) {
        // Indented four columns or more past its block, the marker is the fence's own code.
        if (closes && indent - fence.base < 4) fence = undefined;
        return true;
      }
      // A line that falls short of the block that held the fence ends that block, and the fence with it. The fence's
      // own marker there still closes it, as Bun's Markdown parser reads it, where any other line starts anew.
      fence = undefined;
      if (closes) {
        items.length = held.length;
        return true;
      }
    }

    const outer = held.at(-1) ?? 0;
    const block = ATX.test(line.trimStart()) || ITEM.test(line) || FENCE.test(line) || BARE.test(line);
    const short = held.length < items.length;
    if (paragraph && short && !(indent - outer < 4 && block)) return false;
    items.length = held.length;
    // Indented code, or more of a paragraph: neither opens a fence or an item.
    if (indent - outer >= 4) return false;
    if (BARE.test(line)) {
      // Right under a line of a paragraph in its own block, a marker alone is more of that paragraph.
      if (paragraph && !short) return false;
      items.push(columnsOf(line.trimEnd()) + 1);
      bare = true;
      paragraph = false;
      return false;
    }

    let text = ITEM.exec(line)?.[1];
    if (text === undefined) {
      const marker = FENCE.exec(line)?.[1];
      if (marker !== undefined) fence = { marker, base: outer };
      paragraph = marker === undefined && !ATX.test(line.trimStart());
      return marker !== undefined;
    }
    // An item, and any item that starts on the same line inside it: `- 1. text`.
    for (let inner: string | undefined = text; inner !== undefined; inner = ITEM.exec(inner)?.[1]) {
      text = inner;
      items.push(columnsOf(line.slice(0, line.length - inner.length)));
    }
    const marker = FENCE.exec(text)?.[1];
    if (marker !== undefined) fence = { marker, base: items.at(-1) ?? 0 };
    paragraph = marker === undefined;
    return false;
  });
}

/** The heading's level: 1 to 6 for an ATX heading, 0 for a bold or plain one, or undefined when `line` is no heading. */
function headingLevel(line: string): number | undefined {
  const atx = ATX_HEADING.exec(line);
  if (atx !== null) return (atx[1] ?? '').length;
  return BOLD_HEADING.test(line) || PLAIN_HEADING.test(line) ? 0 : undefined;
}

/** Whether `line` ends the section a heading of `level` opened. */
function endsSection(line: string, level: number): boolean {
  const atx = ATX.exec(line);
  if (atx !== null) return level === 0 || (atx[1] ?? '').length <= level;
  return level === 0 && BOLD.test(line);
}

/** Splits `description` into the request and the acceptance criteria it lists. */
export function splitDescription(description: string): SplitDescription {
  // A line ends at its line feed, with whatever carriage returns came before it.
  const lines = description.split(/\r*\n/);
  // Nothing in a code fence is a heading, a section's end or an item: `# build` there is a comment.
  const code = fenced(lines);
  const at = lines.findIndex((line, index) => !code[index] && headingLevel(line) !== undefined);
  const level = headingLevel(lines[at] ?? '');
  if (level === undefined) return { request: description.trim(), criteria: [] };

  const taken = new Set<number>([at]);
  const criteria: string[][] = [];
  /**
   * The item the lines below may belong to: its indent, and the column its text starts at. An item indented further
   * is nested in it, and one indented as far or less is the next criterion.
   */
  let open: { indent: number; column: number; lines: string[] } | undefined;
  for (let index = at + 1; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (!code[index] && endsSection(line, level)) break;
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    const text = code[index] ? undefined : ITEM.exec(line)?.[1];
    if (text !== undefined && (open === undefined || indent <= open.indent)) {
      open = { indent, column: line.length - text.length, lines: [text.replace(CHECKBOX, '').trimEnd()] };
      criteria.push(open.lines);
      taken.add(index);
    } else if (open !== undefined && indent > open.indent) {
      open.lines.push(line.slice(Math.min(indent, open.column)).trimEnd());
      taken.add(index);
    } else {
      open = undefined;
    }
  }
  if (criteria.length === 0) return { request: description.trim(), criteria: [] };

  const kept = lines.filter((_, index) => !taken.has(index));
  const request = kept
    .join('\n')
    .replace(/\n[^\S\n]*(?:\n[^\S\n]*)+\n/g, '\n\n')
    .trim();
  return { request, criteria: criteria.map((each) => each.join('\n')) };
}
