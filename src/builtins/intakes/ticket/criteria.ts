// splitDescription(): a ticket's description split into the request and its acceptance criteria, the list under an
// "Acceptance criteria" heading. Only what became a criterion leaves the request, so no line of a description is lost.
// A pure function: this module imports nothing.

export interface SplitDescription {
  /** The description without the heading and the criteria's lines. */
  request: string;
  /** Each top-level list item of the section, in order, without its marker or checkbox. */
  criteria: string[];
}

const TEXT = 'acceptance criteria';

/** An ATX heading of any text: `## Notes`. Its level is how many `#` it has. */
const ATX = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
/** The ATX form of the heading: `### Acceptance criteria:`. */
const ATX_HEADING = new RegExp(`^ {0,3}(#{1,6})[ \\t]+${TEXT}[ \\t]*:?[ \\t]*$`, 'i');
/** A line that is bold and nothing else: `**Notes**`, `__Notes:__`. */
const BOLD = /^[ \t]*(\*\*|__)\S(?:.*\S)?\1:?[ \t]*$/;
/** The bold form of the heading: `**Acceptance criteria**`, with a colon inside or after. */
const BOLD_HEADING = new RegExp(`^[ \\t]*(\\*\\*|__)${TEXT}:?\\1:?[ \\t]*$`, 'i');
/** The plain form of the heading, which needs its colon: `Acceptance criteria:`. */
const PLAIN_HEADING = new RegExp(`^[ \\t]*${TEXT}:[ \\t]*$`, 'i');
/** A list item, whose text is the capture: `- text`, `* text`, `+ text`, `1. text`, `1) text`. */
const ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(\S.*)$/;
/** A task checkbox at the start of an item's text: `[ ] `, `[x] `. */
const CHECKBOX = /^\[[ xX]\][ \t]+(?=\S)/;
/** A code fence's line, whose marker is the capture: three or more backticks with no backtick after, or tildes. */
const FENCE = /^[ \t]*(`{3,}(?=[^`]*$)|~{3,})/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Which lines are code: those of a fence, its own two included. A fence runs to a line that is its marker alone, at
 * least as long as the one that opened it, or to the end when it has none.
 */
function fenced(lines: readonly string[]): boolean[] {
  let opened: string | undefined;
  return lines.map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (opened === undefined) {
      opened = marker;
      return opened !== undefined;
    }
    const same = marker !== undefined && marker[0] === opened[0] && marker.length >= opened.length;
    if (same && line.trim() === marker) opened = undefined;
    return true;
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
  const lines = description.split(/\r?\n/);
  // Nothing in a code fence is a heading, a section's end or an item: `# build` there is a comment.
  const code = fenced(lines);
  const at = lines.findIndex((line, index) => !code[index] && headingLevel(line) !== undefined);
  const level = headingLevel(lines[at] ?? '');
  if (level === undefined) return { request: description.trim(), criteria: [] };

  const taken = new Set<number>([at]);
  const criteria: string[][] = [];
  /** The item the lines below may belong to: its indent, and the column its text starts at. */
  let open: { indent: number; column: number; lines: string[] } | undefined;
  /** The indent of the section's first item: an item indented further is nested in the one above it. */
  let top: number | undefined;
  for (let index = at + 1; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (!code[index] && endsSection(line, level)) break;
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    const text = code[index] ? undefined : ITEM.exec(line)?.[1];
    if (text !== undefined && (open === undefined || indent <= (top ?? indent))) {
      top ??= indent;
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
    .replace(/\n[ \t]*(?:\n[ \t]*)+\n/g, '\n\n')
    .trim();
  return { request, criteria: criteria.map((each) => each.join('\n')) };
}
