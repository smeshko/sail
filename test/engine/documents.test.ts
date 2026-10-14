// The engine's side of documents: a step's declaration checked, a template rendered into `$STAGE_OUT`, a produced
// document read with Bun.markdown, and its validators run, guarded, with each problem named after its file and check.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileEntry } from '../../src/engine/contract';
import {
  documentProblems,
  MAX_DOCUMENT_BYTES,
  readDocument,
  renderDocuments,
  validateDocuments,
} from '../../src/engine/documents';
import { untrustedInput } from '../../src/engine/render';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import { countItems, doc, hasSections, noPlaceholders, type Validator } from '../../src/sdk/index';

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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('readDocument reads each heading with its level, and each section as the top-level items up to the next heading of its level or a higher one: fenced code holds neither, a nested item is its parent, and a task item keeps checked', () => {
  const read = readDocument('spec.md', SPEC);
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('renderDocuments writes each template into $STAGE_OUT under its name, with its variables filled, an untrusted value wrapped and every placeholder as written', () => {
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

  expect(renderDocuments({ produces, stageDir, values, outDir })).toEqual({ ok: true });
  expect(readdirSync(outDir).sort()).toEqual(['plan.md', 'spec.md']);
  expect(readFileSync(join(outDir, 'spec.md'), 'utf8')).toBe(
    '# Spec for FAKE-1\n\n<untrusted-input source="ticket FAKE-1, title">\nAdd a --shout flag\n</untrusted-input>\n\n' +
      '## Tasks\n\n{{tasks: one item per task, in order}}\n',
  );
  expect(readFileSync(join(outDir, 'plan.md'), 'utf8')).toBe('{{ plan : the plan, {{ nested }} }}\n');
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('renderDocuments stops at a template that is missing, names an unknown variable, or meets a file already in $STAGE_OUT, with a message naming the document and its template', () => {
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('validateDocuments runs every validator of each produced document in order, all of them after one fails, and gives each problem as invalid_output named by file and check, with the facts derived', () => {
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('validateDocuments leaves out a document the try did not produce, and refuses one over 1 MiB, or one gone from $STAGE_OUT, with one problem and no checks', () => {
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ("a validator that throws, returns no verdict, derives a key it doesn't declare or a value result.json can't hold is a problem named by its check, and what it derived soundly is kept", () => {
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ("documentProblems names two documents' validators that derive one key, with each document and check, and a produces value that is neither 'file' nor a document", () => {
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
