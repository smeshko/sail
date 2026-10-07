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
];

test.each(CASES.map((each) => [each.rule, each] as const))('%s', (_, { description, request, criteria }) => {
  expect(splitDescription(description)).toEqual({ request, criteria });
});

/** The heading in any of its three forms, as a trimmed line. */
const HEADING = /^(?:#{1,6}\s+)?(?:\*\*|__)?acceptance criteria:?(?:\*\*|__)?:?$/i;
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

/** The lines a generated description is made of: every form of the heading, of an item and of a section's end. */
const POOL = [
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

/** A description of 1 to 14 lines from the pool, each line of text numbered so that no two are alike. */
function generated(seed: number): string {
  const random = seeded(seed);
  const count = 1 + Math.floor(random() * 14);
  return Array.from({ length: count }, (_, index) => {
    const line = POOL[Math.floor(random() * POOL.length)] ?? '';
    return line === '' || HEADING.test(line.trim()) ? line : `${line} ${index}`;
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
