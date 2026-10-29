// The engine's side of documents: a step's declaration checked, a template rendered into `$STAGE_OUT`, a produced
// document read with Bun.markdown, and its validators run, guarded, with each problem named after its file and check.
import { afterEach, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileEntry } from '../../src/engine/contract';
import {
  documentProblems,
  MAX_DOCUMENT_BYTES,
  MAX_PROBLEMS_PER_CHECK,
  readDocument as read,
  renderDocuments,
  validateDocuments as validate,
} from '../../src/engine/documents';
import { untrustedInput } from '../../src/engine/render';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import { countItems, doc, hasSections, noPlaceholders, type Validator } from '../../src/sdk/index';

const readDocument = (name: string, text: string, placeholders: string[] = []) => read(name, text, placeholders);
const validateDocuments = (
  options: Omit<Parameters<typeof validate>[0], 'placeholders'> & { placeholders?: Record<string, string[]> },
) => validate({ placeholders: { 'plan.md': ['steps'], 'spec.md': ['x'] }, ...options });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory: a stage directory, or a try's `$STAGE_OUT`. */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-documents-')));
  dirs.push(dir);
  return dir;
}

const golden = join(import.meta.dir, '..', 'fixtures', 'runs', 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N');

/** The issues of the golden run's spec result with `derived` in it: none, when `result.json` can hold it. */
const derivedIssues = (derived: unknown): string[] => {
  const result = JSON.parse(readFileSync(join(golden, '01-spec', 'call-1', 'result.json'), 'utf8'));
  return validateDocument('sail.result.v1', { ...result, derived }).map(formatIssue);
};

const SPEC = `# Spec

## Requirements

- greet --shout prints in capitals
- greet alone is unchanged
  - nested: not a requirement of its own

\`\`\`md
## Not a heading
- not an item
\`\`\`

## Tasks

1. Add the flag
2. Cover it in tests

### Later

- [ ] document it
- [x] name it

# Appendix

- loose
`;

test('readDocument reads each heading with its level, and each section as the top-level items up to the next heading of its level or a higher one: fenced code holds neither, a nested item is its parent, and a task item keeps checked', () => {
  const read = readDocument('spec.md', SPEC, ['tasks']);
  expect([read.placeholders, Object.isFrozen(read.placeholders)]).toEqual([['tasks'], true]);
  expect([read.name, read.text]).toEqual(['spec.md', SPEC]);
  expect(read.headings).toEqual([
    { text: 'Spec', level: 1 },
    { text: 'Requirements', level: 2 },
    { text: 'Tasks', level: 2 },
    { text: 'Later', level: 3 },
    { text: 'Appendix', level: 1 },
  ]);
  const todo = { checked: false };
  const done = { checked: true };
  expect(read.sections).toEqual([
    { heading: 'Spec', level: 1, items: [{}, {}, {}, {}, todo, done] },
    { heading: 'Requirements', level: 2, items: [{}, {}] },
    { heading: 'Tasks', level: 2, items: [{}, {}, todo, done] },
    { heading: 'Later', level: 3, items: [todo, done] },
    { heading: 'Appendix', level: 1, items: [{}] },
  ]);
  expect(read.items).toEqual([{}, {}, {}, {}, todo, done, {}]);
  // A heading's text is its words, trimmed, whatever marks them up.
  expect(readDocument('x.md', '##   The `greet` **command**  \n').headings).toEqual([
    { text: 'The greet command', level: 2 },
  ]);
});

test('readDocument reads headings and items in the order the document holds them, a heading inside a list item after that item (review R1-2)', () => {
  const todo = { checked: false };
  const same = readDocument('spec.md', '## Tasks\n\n- [ ] implement it\n\n  ## Notes\n\n  Details\n\n- second\n');
  expect(same.sections).toEqual([
    { heading: 'Tasks', level: 2, items: [todo] },
    { heading: 'Notes', level: 2, items: [{}] },
  ]);
  const deeper = readDocument('spec.md', '## Tasks\n\n- [ ] a\n\n  ### Detail\n\n- b\n\n## Notes\n');
  expect(deeper.headings.map((heading) => heading.text)).toEqual(['Tasks', 'Detail', 'Notes']);
  expect(deeper.sections).toEqual([
    { heading: 'Tasks', level: 2, items: [todo, {}] },
    { heading: 'Detail', level: 3, items: [{}] },
    { heading: 'Notes', level: 2, items: [] },
  ]);
  expect(deeper.items).toEqual([todo, {}]);
});

test('renderDocuments writes each template into $STAGE_OUT under its name, with its variables filled, an untrusted value wrapped and every placeholder as written', () => {
  const stageDir = tempDir();
  const outDir = tempDir();
  mkdirSync(join(stageDir, 'templates'));
  const spec =
    '# Spec for {{ticket.ticketKey}}\n\n{{ticket.title}}\n\n## Tasks\n\n{{tasks: one item per task, in order}}\n';
  writeFileSync(join(stageDir, 'templates', 'spec.md'), spec);
  writeFileSync(join(stageDir, 'plan.md'), '{{ plan : the plan, {{ nested }} }}\n');
  const values = {
    ticket: { ticketKey: 'FAKE-1', title: untrustedInput('Add a --shout flag', 'ticket FAKE-1, title') },
  };
  const produces = {
    'spec.md': doc('./templates/spec.md', [noPlaceholders()]),
    'notes.md': 'file',
    'plan.md': doc('plan.md'),
  };

  expect(renderDocuments({ produces, stageDir, values, outDir })).toEqual({
    ok: true,
    placeholders: { 'spec.md': ['tasks'], 'plan.md': ['plan'] },
  });
  expect(readdirSync(outDir).sort()).toEqual(['plan.md', 'spec.md']);
  expect(readFileSync(join(outDir, 'spec.md'), 'utf8')).toBe(
    '# Spec for FAKE-1\n\n<untrusted-input source="ticket FAKE-1, title">\nAdd a --shout flag\n</untrusted-input>\n\n' +
      '## Tasks\n\n{{tasks: one item per task, in order}}\n',
  );
  expect(readFileSync(join(outDir, 'plan.md'), 'utf8')).toBe('{{ plan : the plan, {{ nested }} }}\n');
});

test('raw template names include duplicates only once and dropped branches, never inserted values', () => {
  const stageDir = tempDir();
  writeFileSync(
    join(stageDir, 'spec.md'),
    '{{value}}\n{{tasks: first}}\n{{tasks: again}}\n{{#if show}}{{hidden: hint}}{{/if}}',
  );
  expect(
    renderDocuments({
      produces: { 'spec.md': doc('spec.md') },
      stageDir,
      outDir: tempDir(),
      values: { value: '{{color: red}}', show: false },
    }),
  ).toEqual({ ok: true, placeholders: { 'spec.md': ['tasks', 'hidden'] } });
});

test('validation filters inserted tags but reports the template name exactly', () => {
  const out = produced({ 'spec.md': '{{color: red}}\n{{tasks: left}}' });
  expect(
    validateDocuments({
      produces: { 'spec.md': doc('spec.md', [noPlaceholders()]) },
      placeholders: { 'spec.md': ['tasks'] },
      ...out,
    }).errors,
  ).toEqual([
    { reason: 'invalid_output', message: 'spec.md: noPlaceholders: line 2 still holds the placeholder {{tasks: …}}' },
  ]);
});

test('renderDocuments stops at a template that is missing, names an unknown variable, or meets a file already in $STAGE_OUT, with a message naming the document and its template', () => {
  const stageDir = tempDir();
  writeFileSync(join(stageDir, 'spec.md'), '# Spec\n\nFor {{ticket.keey}}\n');
  const values = { ticket: { ticketKey: 'FAKE-1' } };
  const render = (produces: Record<string, unknown>, outDir = tempDir()) =>
    renderDocuments({ produces, stageDir, values, outDir });

  expect(render({ 'spec.md': doc('./missing.md') })).toEqual({
    ok: false,
    message: "'spec.md': template ./missing.md can't be read (ENOENT)",
  });
  expect(render({ 'spec.md': doc('./spec.md') })).toEqual({
    ok: false,
    message: "'spec.md': template ./spec.md: line 3: unknown path `ticket.keey`",
  });
  writeFileSync(join(stageDir, 'plan.md'), '# Plan\n');
  const outDir = tempDir();
  writeFileSync(join(outDir, 'plan.md'), 'left\n');
  expect(render({ 'plan.md': doc('plan.md') }, outDir)).toEqual({
    ok: false,
    message: "'plan.md': template plan.md can't be written to $STAGE_OUT (EEXIST)",
  });
  expect(readFileSync(join(outDir, 'plan.md'), 'utf8')).toBe('left\n');
});

/** Writes `files` into a new `$STAGE_OUT`, and records each as `recordFiles` would: what validateDocuments reads. */
function produced(files: Record<string, string>): { outDir: string; files: Record<string, FileEntry> } {
  const outDir = tempDir();
  const entries = Object.entries(files).map(([name, text]): [string, FileEntry] => {
    writeFileSync(join(outDir, name), text);
    return [name, { path: `01-spec/call-1/${name}`, bytes: Buffer.byteLength(text), sha256: 'x'.repeat(64) }];
  });
  return { outDir, files: Object.fromEntries(entries) };
}

const SPEC_CHECKS = ['hasSections(Requirements, Tasks)', 'noPlaceholders', 'countItems(Tasks, min 1)'];
const specDoc = doc('./templates/spec.md', [
  hasSections('Requirements', 'Tasks'),
  noPlaceholders(),
  countItems('Tasks', { min: 1, as: 'tasks' }),
]);

test('validateDocuments runs every validator of each produced document in order, all of them after one fails, and gives each problem as invalid_output named by file and check, with the facts derived', () => {
  const out = produced({
    'spec.md': SPEC,
    'plan.md': '# Plan\n\n{{steps: one per step}}\n\n## Steps\n',
    'notes.md': 'anything\n',
  });
  const produces = {
    'spec.md': specDoc,
    'notes.md': 'file',
    'plan.md': doc('plan.md', [
      hasSections('Requirements', 'Steps'),
      noPlaceholders(),
      countItems('Steps', { min: 2 }),
    ]),
  };
  const validated = validateDocuments({ produces, ...out });
  expect(validated).toEqual({
    validations: {
      'spec.md': { ok: true, checks: SPEC_CHECKS },
      'plan.md': {
        ok: false,
        checks: ['hasSections(Requirements, Steps)', 'noPlaceholders', 'countItems(Steps, min 2)'],
      },
    },
    derived: { tasks: 4, steps: 0 },
    errors: [
      { reason: 'invalid_output', message: "plan.md: hasSections(Requirements, Steps): has no 'Requirements' section" },
      { reason: 'invalid_output', message: 'plan.md: noPlaceholders: line 3 still holds the placeholder {{steps: …}}' },
      { reason: 'invalid_output', message: "plan.md: countItems(Steps, min 2): 'Steps' has 0 items, fewer than 2" },
    ],
  });
  expect(Object.keys(validated.validations)).toEqual(['spec.md', 'plan.md']);
  expect(derivedIssues(validated.derived)).toEqual([]);
});

test('validateDocuments leaves out a document the try did not produce, and refuses one over 1 MiB, or one gone from $STAGE_OUT, with one problem and no checks', () => {
  const big = 'x'.repeat(MAX_DOCUMENT_BYTES + 1);
  const out = produced({ 'big.md': big, 'gone.md': '# Gone\n' });
  rmSync(join(out.outDir, 'gone.md'));
  const produces = { 'spec.md': specDoc, 'big.md': doc('big.md', [noPlaceholders()]), 'gone.md': specDoc };
  expect(MAX_DOCUMENT_BYTES).toBe(1024 * 1024);
  expect(validateDocuments({ produces, ...out })).toEqual({
    validations: { 'big.md': { ok: false, checks: [] }, 'gone.md': { ok: false, checks: [] } },
    derived: {},
    errors: [
      {
        reason: 'invalid_output',
        message: `big.md: is ${MAX_DOCUMENT_BYTES + 1} bytes, more than the 1 MiB a document may hold to be validated`,
      },
      { reason: 'invalid_output', message: "gone.md: can't be read (ENOENT)" },
    ],
  });
  // One exactly at the limit is read.
  const atLimit = produced({ 'big.md': 'x'.repeat(MAX_DOCUMENT_BYTES) });
  expect(validateDocuments({ produces: { 'big.md': doc('big.md', [noPlaceholders()]) }, ...atLimit })).toEqual({
    validations: { 'big.md': { ok: true, checks: ['noPlaceholders'] } },
    derived: {},
    errors: [],
  });
});

test("a validator that throws, returns no verdict, derives a key it doesn't declare or a value result.json can't hold is a problem named by its check, and what it derived soundly is kept", () => {
  const validator = (check: string, derives: string[], validate: () => unknown): Validator =>
    ({ check, derives, validate }) as Validator;
  const validators = [
    validator('throws', [], () => {
      throw new Error('boom');
    }),
    validator('nothing', [], () => undefined),
    validator('loose', [], () => ({ problems: [7] })),
    validator('undeclared', ['words'], () => ({ problems: [], derived: { words: 3, lines: 9 } })),
    validator('objects', ['shape', 'size', 'tags'], () => ({
      problems: ['too short'],
      derived: { shape: { a: 1 }, size: Number.NaN, tags: ['a', 2, true] },
    })),
    validator('listed', [], () => ({ problems: [], derived: [1] })),
  ];
  const out = produced({ 'spec.md': '# Spec\n' });
  const validated = validateDocuments({ produces: { 'spec.md': doc('spec.md', validators) }, ...out });
  expect(validated).toEqual({
    validations: {
      'spec.md': { ok: false, checks: ['throws', 'nothing', 'loose', 'undeclared', 'objects', 'listed'] },
    },
    derived: { words: 3, tags: ['a', 2, true] },
    errors: [
      'spec.md: throws: threw: boom',
      'spec.md: nothing: returned no verdict: a verdict lists its problems',
      'spec.md: loose: returned no verdict: a verdict lists its problems',
      "spec.md: undeclared: derived 'lines', which it doesn't declare",
      'spec.md: objects: too short',
      "spec.md: objects: derived 'shape' as a value result.json can't hold",
      "spec.md: objects: derived 'size' as a value result.json can't hold",
      'spec.md: listed: derived something other than facts by key',
    ].map((message) => ({ reason: 'invalid_output', message })),
  });
  expect(derivedIssues(validated.derived)).toEqual([]);
});

test("documentProblems names two documents' validators that derive one key, with each document and check, and a produces value that is neither 'file' nor a document", () => {
  const produces = {
    'spec.md': doc('spec.md', [countItems('Tasks'), hasSections('Tasks')]),
    'notes.md': 'file',
    'plan.md': doc('plan.md', [countItems('Tasks', { min: 1, max: 9 })]),
    'odd.md': { kind: 'document', template: 'odd.md' },
  };
  expect(documentProblems(produces)).toEqual([
    "derived key 'tasks' comes from both 'spec.md' (countItems(Tasks)) and 'plan.md' (countItems(Tasks, min 1, max 9))",
    "'odd.md' is neither 'file' nor a document",
  ]);
  expect(documentProblems({ 'spec.md': specDoc, 'notes.md': 'file' })).toEqual([]);
});

test('documentProblems names a hand-built document whose validator has no check label, derives or validate function, rather than throwing (review R1-5)', () => {
  const validate = () => ({ problems: [] });
  const produces = {
    'spec.md': { kind: 'document', template: 'spec.md', validators: [null, { check: 'x', validate }] },
    'plan.md': { kind: 'document', template: 'plan.md', validators: [{ derives: ['n'], validate }] },
    'notes.md': { kind: 'document', template: 'notes.md', validators: [{ check: 'x', derives: [7], validate }] },
    'todo.md': { kind: 'document', template: 'todo.md', validators: [{ check: 'x', derives: [] }] },
  };
  const not = 'is not a validator: it needs a check label, the keys it derives and a validate function';
  expect(documentProblems(produces)).toEqual([
    `'spec.md' validator 0 ${not}`,
    `'spec.md' validator 1 ${not}`,
    `'plan.md' validator 0 ${not}`,
    `'notes.md' validator 0 ${not}`,
    `'todo.md' validator 0 ${not}`,
  ]);
});

test('a validator that changes the document it is handed throws, and the next validator still reads the document as written (review R1-6)', () => {
  const mutates = {
    check: 'mutates',
    derives: [],
    validate: (document: { sections: { items: unknown[] }[]; headings: unknown[] }) => {
      document.headings.reverse();
      document.sections[0]?.items.splice(0);
      return { problems: [] };
    },
  } as unknown as Validator;
  const out = produced({ 'spec.md': '## Tasks\n\n- one\n- two\n' });
  const produces = { 'spec.md': doc('spec.md', [mutates, hasSections('Tasks'), countItems('Tasks')]) };
  const validated = validateDocuments({ produces, ...out });
  expect(validated.derived).toEqual({ tasks: 2 });
  expect(validated.errors).toHaveLength(1);
  expect(validated.errors[0]?.message).toStartWith('spec.md: mutates: threw: ');
  expect(Object.isFrozen(readDocument('spec.md', '## Tasks\n\n- one\n').sections[0]?.items)).toBe(true);
});

test('a document of 1 MiB that is all placeholders is validated in time, and each check gives at most its first 20 problems, then how many more it found (review R1-1)', () => {
  const out = produced({ 'spec.md': '{{x:y}}\n'.repeat(MAX_DOCUMENT_BYTES / 8) });
  const many = { check: 'many', derives: [], validate: () => ({ problems: ['a', 'b', ...Array(20).fill('c')] }) };
  const produces = { 'spec.md': doc('spec.md', [noPlaceholders(), many as Validator]) };
  const started = performance.now();
  const validated = validateDocuments({ produces, ...out });
  expect(performance.now() - started).toBeLessThan(2000);
  expect(validated.errors.map((error) => error.message)).toEqual([
    ...Array.from(
      { length: MAX_PROBLEMS_PER_CHECK },
      (_, index) => `spec.md: noPlaceholders: line ${index + 1} still holds the placeholder {{x: …}}`,
    ),
    `spec.md: noPlaceholders: and ${MAX_DOCUMENT_BYTES / 8 - MAX_PROBLEMS_PER_CHECK} more problems`,
    'spec.md: many: a',
    'spec.md: many: b',
    ...Array(MAX_PROBLEMS_PER_CHECK - 2).fill('spec.md: many: c'),
    'spec.md: many: and 2 more problems',
  ]);
  expect(MAX_PROBLEMS_PER_CHECK).toBe(20);
});

/** A seeded generator of small random numbers, so a failing document can be found again. */
function seeded(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return Math.floor((state / 2147483648) * below);
  };
}

/** A random Markdown block: headings (ATX and setext), lists nested up to twice, task items, fences and quotes. */
function randomBlock(random: (below: number) => number, indent: string, depth: number): string {
  const word = ['Tasks', 'Notes', 'Out of scope', 'x'][random(4)];
  switch (random(9)) {
    case 0:
    case 1:
      return `${indent}${'#'.repeat(1 + random(4))} ${word}\n`;
    case 2:
      return `${indent}${word}\n${indent}${random(2) === 0 ? '===' : '---'}\n`;
    case 3:
      return `${indent}${word} text\n`;
    case 4:
      return `${indent}\`\`\`\n${indent}## ${word}\n${indent}- item\n${indent}\`\`\`\n`;
    case 5:
      return `${indent}> ${['## Quoted', '- quoted', 'text'][random(3)]}\n`;
    default: {
      const ordered = random(3) === 0;
      let out = '';
      for (let index = 0, count = 1 + random(3); index < count; index += 1) {
        out += `${indent}${ordered ? `${index + 1}.` : '-'} ${['', '[ ] ', '[x] '][random(3)]}${word}\n`;
        if (depth < 2 && random(3) === 0)
          out += `\n${randomBlock(random, indent + (ordered ? '   ' : '  '), depth + 1)}\n`;
      }
      return out;
    }
  }
}

/** The sections of `text` as Bun's HTML holds them, in document order: an independent reading to hold readDocument to. */
function sectionsFromHtml(text: string): { heading: string; level: number; items: { checked?: boolean }[] }[] {
  const html = Bun.markdown.html(text);
  const sections: { heading: string; level: number; items: { checked?: boolean }[] }[] = [];
  let open: typeof sections = [];
  let lists = 0;
  for (const match of html.matchAll(/<(\/?)(ul|ol|li|h[1-6])\b[^>]*>/g)) {
    const [, close, tag = ''] = match;
    const after = (match.index ?? 0) + match[0].length;
    if (tag === 'ul' || tag === 'ol') lists += close ? -1 : 1;
    else if (tag === 'li' && !close && lists === 1) {
      const box = /^\s*<input[^>]*type="checkbox"[^>]*>/.exec(html.slice(after, after + 200));
      const item = box === null ? {} : { checked: /checked/.test(box[0]) };
      for (const section of open) section.items.push(item);
    } else if (tag.startsWith('h') && !close) {
      const level = Number(tag[1]);
      const heading = html
        .slice(after, html.indexOf(`</${tag}>`, after))
        .replace(/<[^>]+>/g, '')
        .trim();
      open = open.filter((section) => section.level < level);
      const section = { heading, level, items: [] };
      sections.push(section);
      open.push(section);
    }
  }
  return sections;
}

test("readDocument reads 1,000 random documents' sections as Bun's HTML holds them, in document order (review R1-2)", () => {
  const random = seeded(20261014);
  for (let index = 0; index < 1000; index += 1) {
    let text = '';
    for (let block = 0, count = 2 + random(6); block < count; block += 1) text += `${randomBlock(random, '', 0)}\n`;
    if (random(5) === 0) text = text.replaceAll('\n', '\r\n');
    expect({ text, sections: readDocument('spec.md', text).sections }).toEqual({
      text,
      sections: sectionsFromHtml(text),
    });
  }
});

test("renderDocuments told to replace writes the template afresh over what an earlier try of a step left in its call's $STAGE_OUT, through no link", () => {
  const stageDir = tempDir();
  writeFileSync(join(stageDir, 'plan.md'), '# Plan\n\n{{steps: the steps}}\n');
  const outDir = tempDir();
  const elsewhere = join(tempDir(), 'kept.md');
  writeFileSync(elsewhere, 'kept\n');
  writeFileSync(join(outDir, 'plan.md'), '# Plan\n\n1. half done\n');
  symlinkSync(elsewhere, join(outDir, 'linked.md'));
  const produces = { 'plan.md': doc('plan.md'), 'linked.md': doc('plan.md') };
  expect(renderDocuments({ produces, stageDir, values: {}, outDir, replace: true })).toEqual({
    ok: true,
    placeholders: { 'plan.md': ['steps'], 'linked.md': ['steps'] },
  });
  expect(readFileSync(join(outDir, 'plan.md'), 'utf8')).toBe('# Plan\n\n{{steps: the steps}}\n');
  expect([lstatSync(join(outDir, 'linked.md')).isSymbolicLink(), readFileSync(elsewhere, 'utf8')]).toEqual([
    false,
    'kept\n',
  ]);
});
