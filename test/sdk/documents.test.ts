// doc() and the four built-in validators, each a pure function over a document the engine has parsed. The documents
// here are built by hand, so each case says exactly what a validator is handed.
import { expect, test } from 'bun:test';
import {
  checklist,
  countItems,
  type DocumentContent,
  type DocumentItem,
  type DocumentSection,
  doc,
  hasSections,
  noPlaceholders,
  type Validator,
} from '../../src/sdk/index';

const item: DocumentItem = {};
const open: DocumentItem = { checked: false };
const ticked: DocumentItem = { checked: true };

/** A document of `sections`, each `[heading, level, items]`: its headings, and the top-level items of all of them. */
function parsed(text: string, sections: [string, number, DocumentItem[]][] = [], loose: DocumentItem[] = []) {
  const built: DocumentSection[] = sections.map(([heading, level, items]) => ({ heading, level, items }));
  const content: DocumentContent = {
    name: 'spec.md',
    text,
    headings: built.map(({ heading, level }) => ({ text: heading, level })),
    sections: built,
    items: [...loose, ...built.flatMap((section) => section.items)],
  };
  return content;
}

const custom: Validator = {
  check: 'mine',
  derives: ['words'],
  validate: () => ({ problems: [], derived: { words: 3 } }),
};

test('doc() freezes its template and validators in order, and refuses a blank template or a validator without a check, derives or validate, naming its index', () => {
  const sections = hasSections('Tasks');
  const document = doc('./templates/spec.md', [sections, custom]);
  expect(document).toEqual({ kind: 'document', template: './templates/spec.md', validators: [sections, custom] });
  expect([Object.isFrozen(document), Object.isFrozen(document.validators)]).toEqual([true, true]);
  expect(doc('./templates/plan.md')).toEqual({ kind: 'document', template: './templates/plan.md', validators: [] });

  expect(() => doc(' ', [])).toThrow('doc(): the template must be a path, relative to the stage directory');
  const broken: [unknown, string][] = [
    [{ derives: [], validate: () => ({ problems: [] }) }, 'validator 1 has no check label'],
    [{ check: 'x', validate: () => ({ problems: [] }) }, 'validator 1 must list the keys it derives'],
    [{ check: 'x', derives: [7], validate: () => ({ problems: [] }) }, 'validator 1 must list the keys it derives'],
    [{ check: 'x', derives: [] }, 'validator 1 has no validate function'],
    [null, 'validator 1 is not a validator'],
  ];
  for (const [validator, message] of broken) {
    expect(() => doc('./t.md', [custom, validator as Validator])).toThrow(`doc('./t.md'): ${message}`);
  }
});

test('hasSections passes when each name is a heading at any level, names each one missing, and refuses to be built with none', () => {
  const validator = hasSections('Requirements', 'Tasks', 'Notes');
  expect([validator.check, validator.derives]).toEqual(['hasSections(Requirements, Tasks, Notes)', []]);
  const whole = parsed('', [
    ['Spec', 1, []],
    ['Requirements', 2, []],
    ['Tasks', 3, []],
    ['Notes', 6, []],
  ]);
  expect(validator.validate(whole)).toEqual({ problems: [] });
  // A heading's text must be the name itself: one that only holds it is no section.
  const partial = parsed('', [
    ['Spec', 1, []],
    ['Requirements and risks', 2, []],
    ['Tasks', 2, []],
  ]);
  expect(validator.validate(partial)).toEqual({
    problems: ["has no 'Requirements' section", "has no 'Notes' section"],
  });
  expect(() => hasSections()).toThrow('hasSections(): name at least one section');
});

test('noPlaceholders names each {{name: hint}} tag left, with its line, and passes over variables, unclosed tags and colons outside a tag', () => {
  const validator = noPlaceholders();
  expect([validator.check, validator.derives]).toEqual(['noPlaceholders', []]);
  const clean = parsed('# Spec\n\nNote: {{ticket.key}} stays, as does a time of 10:30.\n\n{{ unclosed: tag\n');
  expect(validator.validate(clean)).toEqual({ problems: [] });
  const left = parsed('# Spec\n\n## Requirements\n\n{{requirements: one per criterion}}\n\n- a {{ tasks : x }}\n');
  expect(validator.validate(left)).toEqual({
    problems: [
      'line 5 still holds the placeholder {{requirements: …}}',
      'line 7 still holds the placeholder {{tasks: …}}',
    ],
  });
});

test('countItems counts the items of the section its heading names, derives the count, and reports an absent section or a count out of bounds', () => {
  const document = parsed('', [
    ['Spec', 1, []],
    ['Tasks', 2, [item, item, item]],
    ['Details', 3, [item]],
  ]);
  const within = countItems('Tasks', { min: 3, max: 3, as: 'taskCount' });
  expect([within.check, within.derives]).toEqual(['countItems(Tasks, min 3, max 3)', ['taskCount']]);
  expect(within.validate(document)).toEqual({ problems: [], derived: { taskCount: 3 } });

  const fewer = countItems('Tasks', { min: 4 });
  expect(fewer.validate(document)).toEqual({
    problems: ["'Tasks' has 3 items, fewer than 4"],
    derived: { tasks: 3 },
  });
  const more = countItems('Details', { max: 0 });
  expect(more.validate(document)).toEqual({
    problems: ["'Details' has 1 item, more than 0"],
    derived: { details: 1 },
  });
  expect(countItems('Notes', { min: 1 }).validate(document)).toEqual({ problems: ["has no 'Notes' section"] });
});

test("countItems derives under the section's words in camelCase unless as names a key, and labels only the bounds it was given", () => {
  const cases: [Validator, string, string][] = [
    [countItems('Tasks'), 'countItems(Tasks)', 'tasks'],
    [countItems('Out of scope', { min: 0 }), 'countItems(Out of scope, min 0)', 'outOfScope'],
    [countItems('Open questions (API)', { max: 9 }), 'countItems(Open questions (API), max 9)', 'openQuestionsApi'],
    [countItems('Requirements', { min: 1, as: 'requirements' }), 'countItems(Requirements, min 1)', 'requirements'],
  ];
  expect(cases.map(([validator]) => [validator.check, validator.derives])).toEqual(
    cases.map(([, check, key]) => [check, [key]]),
  );
  expect(() => countItems('—')).toThrow('countItems(—): as must be a key of one or more characters');
});

test('checklist counts the top-level task items of the whole document and the checked ones, derives both, and reports a count out of bounds', () => {
  const document = parsed(
    '',
    [
      ['Plan', 2, [open, item, ticked]],
      ['Later', 3, [ticked]],
    ],
    [open],
  );
  const counted = checklist({ min: 1, max: 4 });
  expect([counted.check, counted.derives]).toEqual(['checklist(min 1, max 4)', ['checklist', 'checklistDone']]);
  expect(counted.validate(document)).toEqual({ problems: [], derived: { checklist: 4, checklistDone: 2 } });

  const named = checklist({ max: 3, as: 'steps' });
  expect([named.check, named.derives]).toEqual(['checklist(max 3)', ['steps', 'stepsDone']]);
  expect(named.validate(document)).toEqual({
    problems: ['has 4 checklist items, more than 3'],
    derived: { steps: 4, stepsDone: 2 },
  });
  const none = checklist({ min: 1 });
  expect(none.validate(parsed('', [['Plan', 2, [item]]]))).toEqual({
    problems: ['has 0 checklist items, fewer than 1'],
    derived: { checklist: 0, checklistDone: 0 },
  });
  expect(checklist().check).toBe('checklist');
});

test('bounds that are not whole numbers of 0 or more, a min above its max, or an empty as throw when the validator is built', () => {
  const refused: [() => Validator, string][] = [
    [() => countItems('Tasks', { min: -1 }), 'countItems(Tasks): min must be a whole number of 0 or more: -1'],
    [() => countItems('Tasks', { max: 1.5 }), 'countItems(Tasks): max must be a whole number of 0 or more: 1.5'],
    [() => countItems('Tasks', { min: 3, max: 2 }), 'countItems(Tasks): min 3 is more than max 2'],
    [() => countItems('Tasks', { as: '' }), 'countItems(Tasks): as must be a key of one or more characters'],
    [() => checklist({ min: Number.NaN }), 'checklist(): min must be a whole number of 0 or more: NaN'],
    [() => checklist({ min: 2, max: 1 }), 'checklist(): min 2 is more than max 1'],
  ];
  for (const [build, message] of refused) expect(build).toThrow(message);
  expect(countItems('Tasks', { min: 0, max: 0 }).check).toBe('countItems(Tasks, min 0, max 0)');
});
