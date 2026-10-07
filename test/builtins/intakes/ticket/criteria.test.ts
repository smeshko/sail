// splitDescription(): one case per rule of D3, as a table of a description, its request and its criteria. Then the
// rule the table can't state: whatever the description, no line of it is lost.
import { expect, test } from 'bun:test';
import { type SplitDescription, splitDescription } from '../../../../src/builtins/intakes/ticket/criteria';

const lines = (...each: string[]): string => each.join('\n');

interface Case extends SplitDescription {
  rule: string;
  description: string;
}

const CASES: Case[] = [
  {
    rule: 'a ## heading and a - list give one criterion per item, in order',
    description: lines('Add a flag.', '', '## Acceptance criteria', '', '- prints HELLO', '- keeps hello', '- help'),
    request: 'Add a flag.',
    criteria: ['prints HELLO', 'keeps hello', 'help'],
  },
  {
    rule: 'the heading matches at level 1, in upper case and with a colon',
    description: lines('Intro.', '# ACCEPTANCE CRITERIA:', '* one'),
    request: 'Intro.',
    criteria: ['one'],
  },
  {
    rule: 'the heading matches at level 6, in mixed case',
    description: lines('###### acceptance Criteria', '+ one', 'Outro.'),
    request: 'Outro.',
    criteria: ['one'],
  },
  {
    rule: 'the heading matches in bold, alone on its line',
    description: lines('Intro.', '', '**Acceptance criteria**', '- one', '- two'),
    request: 'Intro.',
    criteria: ['one', 'two'],
  },
  {
    rule: 'the heading matches in bold with its colon',
    description: lines('**Acceptance Criteria:**', '- one'),
    request: '',
    criteria: ['one'],
  },
  {
    rule: 'the heading matches as plain text ending in a colon',
    description: lines('Intro.', 'Acceptance criteria:', '1. one', '2) two'),
    request: 'Intro.',
    criteria: ['one', 'two'],
  },
  {
    rule: 'a sentence that mentions the words is no heading',
    description: lines('The acceptance criteria are in the list below:', '- not a criterion'),
    request: lines('The acceptance criteria are in the list below:', '- not a criterion'),
    criteria: [],
  },
  {
    rule: 'plain text without its colon is no heading',
    description: lines('Acceptance criteria', '- not a criterion'),
    request: lines('Acceptance criteria', '- not a criterion'),
    criteria: [],
  },
  {
    rule: 'every list marker makes a criterion',
    description: lines('## Acceptance criteria', '- dash', '* star', '+ plus', '1. dot', '2) paren'),
    request: '',
    criteria: ['dash', 'star', 'plus', 'dot', 'paren'],
  },
  {
    rule: 'a leading task checkbox is dropped, checked or not, and nothing else in brackets is',
    description: lines('## Acceptance criteria', '- [ ] open', '- [x] done', '* [X] DONE', '- [maybe] kept'),
    request: '',
    criteria: ['open', 'done', 'DONE', '[maybe] kept'],
  },
  {
    rule: 'lines indented under an item stay in it, a nested list and a line after a blank one included',
    description: lines('## Acceptance criteria', '- first', '  continued', '  - nested', '- second', '', '  later'),
    request: '',
    criteria: [lines('first', 'continued', '- nested'), lines('second', 'later')],
  },
  {
    rule: 'the section ends at the next heading of the same level',
    description: lines('## Acceptance criteria', '- one', '## Notes', '- not a criterion'),
    request: lines('## Notes', '- not a criterion'),
    criteria: ['one'],
  },
  {
    rule: 'the section ends at a heading of a higher level',
    description: lines('### Acceptance criteria', '- one', '# Notes', '- not a criterion'),
    request: lines('# Notes', '- not a criterion'),
    criteria: ['one'],
  },
  {
    rule: 'a deeper heading is inside the section',
    description: lines('## Acceptance criteria', '- one', '### Edge cases', '- two'),
    request: '### Edge cases',
    criteria: ['one', 'two'],
  },
  {
    rule: 'after a bold heading the section ends at the next heading of any level',
    description: lines('**Acceptance criteria**', '- one', '#### Notes', '- not a criterion'),
    request: lines('#### Notes', '- not a criterion'),
    criteria: ['one'],
  },
  {
    rule: 'after a plain heading the section ends at the next line that is bold alone',
    description: lines('Acceptance criteria:', '- one', '**Notes**', '- not a criterion'),
    request: lines('**Notes**', '- not a criterion'),
    criteria: ['one'],
  },
  {
    rule: 'a line of the section that belongs to no item stays in the request, where it was',
    description: lines('Intro.', '## Acceptance criteria', 'These must hold:', '- one', 'And then:', '- two', 'Outro.'),
    request: lines('Intro.', 'These must hold:', 'And then:', 'Outro.'),
    criteria: ['one', 'two'],
  },
  {
    rule: 'a section with no list item removes nothing',
    description: lines('Intro.', '', '## Acceptance criteria', '', 'To be agreed.', ''),
    request: lines('Intro.', '', '## Acceptance criteria', '', 'To be agreed.'),
    criteria: [],
  },
  {
    rule: 'a description with no such heading is all request, trimmed',
    description: lines('', '  Add a flag.', '- a list that is no criterion', ''),
    request: lines('Add a flag.', '- a list that is no criterion'),
    criteria: [],
  },
  { rule: 'an empty description gives nothing', description: '', request: '', criteria: [] },
  {
    rule: 'only the first section counts, and a second stays in the request whole',
    description: lines('## Acceptance criteria', '- one', '## Acceptance criteria', '- two'),
    request: lines('## Acceptance criteria', '- two'),
    criteria: ['one'],
  },
  {
    rule: 'CRLF line endings give the same criteria as LF',
    description: 'Intro.\r\n## Acceptance criteria\r\n- one\r\n- [ ] two\r\n',
    request: 'Intro.',
    criteria: ['one', 'two'],
  },
  {
    rule: 'the request is trimmed, and the blank lines the removal leaves are one',
    description: lines('', 'Intro.', '', '## Acceptance criteria', '', '- one', '', 'Outro.', ''),
    request: lines('Intro.', '', 'Outro.'),
    criteria: ['one'],
  },
  {
    rule: "a # line in a code fence under an item is the item's, and the items after the fence are still criteria",
    description: lines(
      '## Acceptance criteria',
      '- the script works:',
      '  ```sh',
      '  # build first',
      '  make',
      '  ```',
      '- second',
      '- third',
    ),
    request: '',
    criteria: [lines('the script works:', '```sh', '# build first', 'make', '```'), 'second', 'third'],
  },
  {
    rule: 'a code fence between two items stays in the request whole, and ends neither the section nor the list',
    description: lines('## Acceptance criteria', '- one', '```sh', '# build', '- no item', '```', '- two', '## Notes'),
    request: lines('```sh', '# build', '- no item', '```', '## Notes'),
    criteria: ['one', 'two'],
  },
  {
    rule: 'a heading inside a code fence is no heading: the section is the one outside it',
    description: lines(
      'Template:',
      '~~~md',
      '## Acceptance criteria',
      '- sample',
      '~~~',
      '## Acceptance criteria',
      '- real',
    ),
    request: lines('Template:', '~~~md', '## Acceptance criteria', '- sample', '~~~'),
    criteria: ['real'],
  },
  {
    rule: 'a code fence closes only on its own marker, at least as long as the one that opened it',
    description: lines('## Acceptance criteria', '- one', '````', '```', '# still code', '~~~', '````', '- two'),
    request: lines('````', '```', '# still code', '~~~', '````'),
    criteria: ['one', 'two'],
  },
  {
    rule: 'a code fence that never closes runs to the end',
    description: lines('## Acceptance criteria', '- one', '```', '- no item', '## no heading'),
    request: lines('```', '- no item', '## no heading'),
    criteria: ['one'],
  },
  {
    rule: 'a line that starts with code in three backticks opens no code fence',
    description: lines('## Acceptance criteria', '- one', '```make``` builds it:', '- two'),
    request: '```make``` builds it:',
    criteria: ['one', 'two'],
  },
  {
    rule: 'after a line that belongs to no item, every item of an indented list is a criterion',
    description: lines('## Acceptance criteria', '- A', 'Some prose', '  - x', '  - y', '  - z'),
    request: 'Some prose',
    criteria: ['A', 'x', 'y', 'z'],
  },
  {
    rule: 'an item indented under the one above it is nested in it, however far the first item was indented',
    description: lines('## Acceptance criteria', '  - A', '- B', '  - C', '- D'),
    request: '',
    criteria: ['A', lines('B', '- C'), 'D'],
  },
  {
    rule: 'a no-break space after the heading leaves it the heading, and after a bold line leaves it bold alone',
    description: lines('Intro.', '**Acceptance criteria:**\u00a0', '- one', '**Notes**\u00a0', '- no criterion'),
    request: lines('Intro.', '**Notes**\u00a0', '- no criterion'),
    criteria: ['one'],
  },
  {
    rule: "a no-break space between the heading's words, after a marker or a checkbox, or as an indent, is a space",
    description: lines(
      'Acceptance\u00a0criteria:',
      '-\u00a0one',
      '\u00a0\u00a0more',
      '1.\u00a0two',
      '- [x]\u00a0three',
    ),
    request: '',
    criteria: [lines('one', 'more'), 'two', 'three'],
  },
  {
    rule: 'an item whose text holds a line separator is one criterion, whole',
    description: lines('## Acceptance criteria', '- one\u2028more', '- two'),
    request: '',
    criteria: ['one\u2028more', 'two'],
  },
  {
    rule: 'a line ending with a stray carriage return before its CRLF ends the same',
    description: 'Intro.\r\r\n## Acceptance criteria\r\r\n- one\r\r\n- two\r\r\n',
    request: 'Intro.',
    criteria: ['one', 'two'],
  },
  {
    rule: 'a line of no-break spaces alone is a blank line',
    description: lines('Intro.', '\u00a0', '## Acceptance criteria', '- one', '\u00a0', 'Outro.'),
    request: lines('Intro.', '', 'Outro.'),
    criteria: ['one'],
  },
  {
    rule: "a code fence that opens on an item's own line is the item's, and the items after it are still criteria",
    description: lines(
      '## Acceptance criteria',
      '- ```sh',
      '  # build first',
      '  make',
      '  ```',
      '- second',
      '- third',
    ),
    request: '',
    criteria: [lines('```sh', '# build first', 'make', '```'), 'second', 'third'],
  },
  {
    rule: 'backticks indented four spaces, or by a tab, are an indented code block and open no code fence',
    description: lines('Intro.', '', '    ```', '', '\t~~~', '', '## Acceptance criteria', '- one'),
    request: lines('Intro.', '', '    ```', '', '\t~~~'),
    criteria: ['one'],
  },
  {
    rule: 'a code fence left open in an item ends with the item',
    description: lines('## Acceptance criteria', '- one', '  ```', '  # code', '- two', '## Notes', '- no criterion'),
    request: lines('## Notes', '- no criterion'),
    criteria: [lines('one', '```', '# code'), 'two'],
  },
  {
    rule: "backticks indented four spaces past an item's text are the item's code, and open no code fence",
    description: lines('## Acceptance criteria', '- one', '', '      ```', '', '- two', '## Notes'),
    request: '## Notes',
    criteria: [lines('one', '    ```'), 'two'],
  },
  {
    rule: "a line of text right under an item goes on with its paragraph, so a fence indented under it is the item's",
    description: lines('## Acceptance criteria', '- one', 'goes on', '  ```', '# Notes', '- no criterion'),
    request: lines('goes on', '  ```', '# Notes', '- no criterion'),
    criteria: ['one'],
  },
  {
    rule: "a fence's marker indented four spaces past its block is the fence's own code, and closes nothing",
    description: lines('## Acceptance criteria', '- one', '```', '    ```', '- no item', '```', '- two'),
    request: lines('```', '    ```', '- no item', '```'),
    criteria: ['one', 'two'],
  },
  {
    rule: "a fence left open in an item is closed by its own marker at the margin, as Bun's Markdown parser reads it",
    description: lines('## Acceptance criteria', '- one', '  ```', '  # code', '```', '- two', '## Notes'),
    request: lines('```', '## Notes'),
    criteria: [lines('one', '```', '# code'), 'two'],
  },
];

test.each(CASES.map((each) => [each.rule, each] as const))('%s', (_, { description, request, criteria }) => {
  expect(splitDescription(description)).toEqual({ request, criteria });
});

/** The heading in any of its three forms, as a trimmed line. */
const HEADING = /^(?:#{1,6}\s+)?(?:\*\*|__)?acceptance\s+criteria:?(?:\*\*|__)?:?$/i;
/** A list marker, with a task checkbox when one follows it: what an item's first line loses on its way to a criterion. */
const MARKER = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;

/**
 * The non-blank lines of `description` that are in neither the request nor a criterion. Each line of the split is
 * matched once, so a line the description holds twice must be kept twice. One heading may go, with the criteria.
 */
function lost(description: string, { request, criteria }: SplitDescription): string[] {
  const kept = [...request.split('\n'), ...criteria.flatMap((each) => each.split('\n'))].map((line) => line.trim());
  let heading = criteria.length > 0;
  const take = (line: string): boolean => {
    const index = kept.indexOf(line);
    if (index !== -1) kept.splice(index, 1);
    return index !== -1;
  };
  return description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => {
      if (take(line) || take(line.replace(MARKER, ''))) return false;
      if (heading && HEADING.test(line)) {
        heading = false;
        return false;
      }
      return true;
    });
}

/** A seeded generator of numbers in [0, 1): mulberry32, so a failing description can be made again from its seed. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** A code fence's line with no info string: one that can close a fence as well as open one. */
const BARE_FENCE = /^(?:`{3,}|~{3,})$/;

/** The lines a generated description is made of: every form of the heading, of an item, of a section's end and of a fence. */
const POOL = [
  '## Acceptance criteria\u00a0',
  '-\u00a0no-break item',
  '```',
  '```sh',
  '  ```',
  '~~~',
  'Some prose',
  'More prose:',
  '## Acceptance criteria',
  '### acceptance criteria:',
  '**Acceptance criteria**',
  'Acceptance criteria:',
  '## Notes',
  '# Top',
  '#### Deeper',
  '**Bold alone**',
  '- dash item',
  '* star item',
  '1. numbered item',
  '- [ ] open task',
  '- [x] done task',
  '  indented line',
  '  - nested item',
  '    deeper line',
  '',
  '',
];

/**
 * A description of 1 to 14 lines from the pool, each line of text numbered so that no two are alike. A bare fence stays
 * bare, or it could close nothing.
 */
function generated(seed: number): string {
  const random = seeded(seed);
  const count = 1 + Math.floor(random() * 14);
  return Array.from({ length: count }, (_, index) => {
    const line = POOL[Math.floor(random() * POOL.length)] ?? '';
    return line === '' || HEADING.test(line.trim()) || BARE_FENCE.test(line.trim()) ? line : `${line} ${index}`;
  }).join('\n');
}

test('no line is lost: every non-blank line of a description is in the request, in a criterion, or is the heading', () => {
  const descriptions = [
    ...CASES.map((each) => each.description),
    ...Array.from({ length: 400 }, (_, i) => generated(i)),
  ];
  const broken = descriptions.flatMap((description) => {
    const split = splitDescription(description);
    const gone = lost(description, split);
    // With no criterion nothing was removed, so the request is the description as it came.
    const whole = split.criteria.length > 0 || split.request === description.trim();
    return gone.length === 0 && whole ? [] : [{ description, split, gone }];
  });
  expect(broken).toEqual([]);
  // The generated descriptions reach both sides of the rule: some list criteria, and some list none.
  const withCriteria = descriptions.filter((description) => splitDescription(description).criteria.length > 0);
  expect(withCriteria.length).toBeGreaterThan(50);
  expect(descriptions.length - withCriteria.length).toBeGreaterThan(50);
});

// A section built from parts, so the criteria it holds are known as it is made, with no second splitter to say so. Each
// part is a shape of fence that a line-by-line reading gets wrong, and every fence holds lines that would be a heading
// or an item outside one. Bun's own Markdown parser then confirms the parts are what Markdown says they are.

interface Built {
  description: string;
  criteria: string[];
  /** The description's lines that belong to the request, the blank ones left out. */
  kept: string[];
  /** The headings a Markdown reader sees, in order. */
  headings: string[];
}

function built(seed: number): Built {
  const random = seeded(seed);
  const pick = <T>(of: readonly T[]): T => of[Math.floor(random() * of.length)] as T;
  let named = 0;
  /** A name no other line holds, so a line is found again in what a parser makes of it. */
  const token = () => `L${named++}`;
  const fence = () => pick(['```', '~~~', '````']);
  /** What a fence must keep to itself: a heading that would end the section, an item, and the heading itself. */
  const hostile = () => [`# Top ${token()}`, `- dash ${token()}`, '## Acceptance criteria'];

  const out: string[] = [];
  const criteria: string[] = [];
  const kept: string[] = [];
  const keep = (...each: string[]) => {
    out.push(...each);
    kept.push(...each);
  };
  /** An item and the lines under it: one criterion. */
  const item = (text: string, ...under: string[]) => {
    out.push(`- ${text}`, ...under.map((line) => `  ${line}`));
    criteria.push([text, ...under].join('\n'));
  };
  const fencedUnder = () => {
    const marker = fence();
    item(`item ${token()}`, marker, ...hostile(), marker);
  };
  const fencedOnItsLine = () => {
    const marker = fence();
    item(`${marker}${token()}`, ...hostile(), marker);
  };
  /** A fence left open in an item, which the next item ends. */
  const leftOpen = () => {
    item(`item ${token()}`, fence(), ...hostile());
    item(`item ${token()}`);
  };
  const atTheMargin = () => {
    const marker = fence();
    keep(marker, ...hostile(), marker);
  };
  const parts = [
    () => item(`item ${token()}`),
    () => item(`item ${token()}`, `more ${token()}`),
    fencedUnder,
    fencedOnItsLine,
    leftOpen,
    atTheMargin,
    // A longer fence that holds a shorter one.
    () => keep('````', '```', ...hostile(), '````'),
    () => keep(`prose ${token()}`),
    // Backticks indented as code, which open no fence.
    () => keep('', `prose ${token()}`, '', `    \`\`\`${token()}`, ''),
  ];

  keep(`Intro ${token()}`);
  // Before the section: a template in a fence, indented backticks, and a fence left open in an item.
  if (random() < 0.5) keep('```md', '## Acceptance criteria', `- sample ${token()}`, '```');
  if (random() < 0.3) keep('', `    \`\`\`${token()}`, '');
  if (random() < 0.3) keep(`- before ${token()}`, '  ~~~', '  ## Acceptance criteria', `prose ${token()}`);
  out.push('## Acceptance criteria');
  const count = 1 + Math.floor(random() * 6);
  for (let index = 0; index < count; index++) pick(parts)();
  const headings = ['Acceptance criteria'];
  if (random() < 0.5) {
    const notes = `Notes ${token()}`;
    keep(`## ${notes}`, `- no criterion ${token()}`);
    headings.push(notes);
  }
  // With no criterion nothing is removed, the heading included.
  const request = criteria.length === 0 ? out : kept;
  return { description: out.join('\n'), criteria, kept: request.filter((line) => line.trim() !== ''), headings };
}

const BUILT = Array.from({ length: 300 }, (_, seed) => built(seed));

test('a section built from fenced parts gives the criteria it was built with, whatever its fences hold', () => {
  const wrong = BUILT.flatMap(({ description, criteria, kept }) => {
    const split = splitDescription(description);
    const request = split.request.split('\n').filter((line) => line.trim() !== '');
    const same = Bun.deepEquals(split.criteria, criteria) && Bun.deepEquals(request, kept);
    return same ? [] : [{ description, split, criteria, kept }];
  });
  expect(wrong).toEqual([]);
  // The built sections reach the shapes a flat reading of fences gets wrong.
  const holding = (pattern: RegExp) => BUILT.filter(({ description }) => pattern.test(description)).length;
  expect(holding(/^- (?:`{3,}|~{3,})L\d+$/m)).toBeGreaterThan(50);
  expect(holding(/^ {4}`{3}L\d+$/m)).toBeGreaterThan(50);
  expect(BUILT.filter(({ criteria }) => criteria.length === 0).length).toBeGreaterThan(5);
});

/** A line's own name, as the built and the random descriptions give one. */
const TOKEN = /L\d+/;

interface Read {
  heading?: { text: string; level: number };
  /** A top-level list item's text, with the code under it. */
  item?: string;
}

/** What Bun's Markdown parser makes of `description`: its headings and its top-level list items, in order. */
function readByBun(description: string): Read[] {
  const seen: Read[] = [];
  Bun.markdown.render(description, {
    heading: (children, meta) => {
      seen.push({ heading: { text: children, level: meta.level } });
      return children;
    },
    // The info string goes first: it is the name of a fence that opens on an item's own line.
    code: (children, meta) => `${meta?.language ?? ''}\n${children}`,
    listItem: (children, meta) => {
      if (meta.depth === 0) seen.push({ item: children });
      return children;
    },
  });
  return seen;
}

/** The name of each top-level item between the heading and the next one of its level or higher. */
function sectionItems(seen: readonly Read[]): (string | undefined)[] {
  const at = seen.findIndex((each) => each.heading?.text === 'Acceptance criteria');
  if (at === -1) return [];
  const level = seen[at]?.heading?.level ?? 0;
  const section = seen.slice(at + 1);
  const end = section.findIndex((each) => each.heading !== undefined && each.heading.level <= level);
  return (end === -1 ? section : section.slice(0, end))
    .filter((each) => each.item !== undefined)
    .map((each) => TOKEN.exec(each.item ?? '')?.[0]);
}

test("Bun's Markdown parser reads each built section as it was built: its headings, and one item per criterion", () => {
  const wrong = BUILT.flatMap(({ description, criteria, headings }) => {
    const seen = readByBun(description);
    const read = { headings: seen.flatMap((each) => each.heading?.text ?? []), items: sectionItems(seen) };
    const expected = { headings, items: criteria.map((each) => TOKEN.exec(each)?.[0]) };
    return Bun.deepEquals(read, expected) ? [] : [{ description, read, expected }];
  });
  expect(wrong).toEqual([]);
});

// Random descriptions of fence shapes, read by the splitter and by Bun's Markdown parser. The pool holds only lines on
// which D3 and Markdown agree about what a top-level item is, so the two can differ only over where a fence runs.

/** `@` is where a line's own name goes. A fence line with none can close a fence as well as open one. */
const FENCE_POOL = [
  '- item @',
  '- item @',
  '- item @',
  '* item @',
  '1. item @',
  '-   item @',
  'prose @',
  '  more @',
  '   more @',
  '    more @',
  '',
  '',
  '```',
  ' ```',
  '  ```',
  '   ```',
  '    ```',
  '     ```',
  '      ```',
  '\t```',
  '~~~',
  '  ~~~',
  '   ~~~',
  '````',
  '  ````',
  '`````',
  '```@',
  '  ```@',
  '    ```@',
  '- ```@',
  '- ~~~@',
  '1. ```@',
  '- - item @',
  '- - ```@',
  '## Notes @',
  '### Deeper @',
  '## Acceptance criteria',
  '# Top @',
];

/** A section of 2 to 13 lines from the fence pool, under the heading. */
function fencedAtRandom(seed: number): string {
  const random = seeded(seed);
  const count = 2 + Math.floor(random() * 12);
  const section = Array.from({ length: count }, (_, index) =>
    (FENCE_POOL[Math.floor(random() * FENCE_POOL.length)] ?? '').replace('@', `L${index}`),
  );
  return ['Intro L99', '## Acceptance criteria', ...section].join('\n');
}

test("over random fence shapes, the criteria are the section's top-level items as Bun's Markdown parser reads them", () => {
  const descriptions = Array.from({ length: 3000 }, (_, seed) => fencedAtRandom(seed));
  const differing = descriptions.flatMap((description) => {
    const criteria = splitDescription(description).criteria.map((each) => TOKEN.exec(each)?.[0]);
    const items = sectionItems(readByBun(description));
    return Bun.deepEquals(criteria, items) ? [] : [{ description, criteria, items }];
  });
  expect(differing).toEqual([]);
  // The descriptions reach both sides: sections that list criteria, and sections whose fences leave none.
  const withCriteria = descriptions.filter((description) => splitDescription(description).criteria.length > 0);
  expect(withCriteria.length).toBeGreaterThan(500);
  expect(descriptions.length - withCriteria.length).toBeGreaterThan(100);
});
