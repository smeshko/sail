import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindingProblems,
  inputVar,
  materialise,
  materialisePrepared,
  prepareBindings,
  type Supplied,
} from '../../src/engine/bindings';
import { type Consumes, file, fromStep, gitDiff, value, z } from '../../src/sdk/index';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-bindings-'));
  dirs.push(dir);
  return dir;
}

/** A source file to bind, and an empty `$STAGE_IN` to materialise into. */
function scratch(): { source: (name: string, text: string) => string; stageIn: string } {
  const dir = tempDir();
  const stageIn = join(dir, 'call-1', 'in');
  mkdirSync(stageIn, { recursive: true });
  return {
    source: (name, text) => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    },
    stageIn,
  };
}

const TicketInput = z.object({ key: z.string(), labels: z.array(z.string()).default([]) });
const fileAt = (path: string, from = path): Supplied => ({ kind: 'file', path, from });
const given = (data: unknown): Supplied => ({ kind: 'value', value: data, from: '--bind' });

test('INPUT_ names upper-case the binding and turn anything else into _', () => {
  expect(inputVar('spec')).toBe('INPUT_SPEC');
  expect(inputVar('self-review')).toBe('INPUT_SELF_REVIEW');
  expect(inputVar('pr.body')).toBe('INPUT_PR_BODY');
});

test('a bound file is copied into $STAGE_IN under its declared name', () => {
  const s = scratch();
  const path = s.source('draft.md', '# spec\n');
  const consumes: Consumes = { spec: file('spec.md') };
  expect(bindingProblems(consumes, { spec: fileAt(path, 'draft.md') })).toEqual([]);
  const { inputs, consumed } = materialise(consumes, { spec: fileAt(path, 'draft.md') }, s.stageIn);
  expect(inputs).toEqual({ INPUT_SPEC: join(s.stageIn, 'spec.md') });
  expect(readFileSync(join(s.stageIn, 'spec.md'), 'utf8')).toBe('# spec\n');
  expect(consumed).toEqual({ spec: 'draft.md' });
});

test('a value is written as <name>.json holding its parsed value, and a string as <name>.txt', () => {
  const s = scratch();
  const consumes: Consumes = { ticket: value(TicketInput), note: value(z.string()) };
  const supplied = { ticket: given({ key: 'FAKE-1' }), note: given('hello\nworld') };
  const { inputs, consumed } = materialise(consumes, supplied, s.stageIn);
  expect(inputs).toEqual({
    INPUT_TICKET: join(s.stageIn, 'ticket.json'),
    INPUT_NOTE: join(s.stageIn, 'note.txt'),
  });
  expect(readFileSync(join(s.stageIn, 'ticket.json'), 'utf8')).toBe(
    `${JSON.stringify({ key: 'FAKE-1', labels: [] }, null, 2)}\n`,
  );
  expect(readFileSync(join(s.stageIn, 'note.txt'), 'utf8')).toBe('hello\nworld');
  expect(consumed).toEqual({ ticket: '--bind', note: '--bind' });
});

test('an optional binding left unbound writes nothing and is consumed as null', () => {
  const s = scratch();
  const consumes: Consumes = { spec: file('spec.md').optional(), note: value(z.string()).optional() };
  expect(materialise(consumes, {}, s.stageIn)).toEqual({ inputs: {}, consumed: { spec: null, note: null } });
  expect(readdirSync(s.stageIn)).toEqual([]);
});

test.each([
  ['a name the stage does not consume', {}, { nope: given(1) }, ["'nope' is not a binding of this stage"]],
  ['a required binding left out', { spec: file('spec.md') }, {}, ["'spec' is required"]],
  [
    'a gitDiff binding',
    { diff: gitDiff('origin/main...HEAD') },
    { diff: given('x') },
    ["'diff' is a gitDiff binding, which can't be supplied here"],
  ],
  [
    'a fromStep binding, even left out',
    { draft: fromStep('describe').output() },
    {},
    ["'draft' is a fromStep binding, which can't be supplied here"],
  ],
  [
    'a value for a file',
    { spec: file('spec.md') },
    { spec: given('x') },
    ["'spec' is a file binding, but a value was supplied"],
  ],
  [
    'a file for a value',
    { ticket: value(TicketInput) },
    { ticket: fileAt('/x') },
    ["'ticket' is a value binding, but a file was supplied"],
  ],
  [
    'a value its schema rejects',
    { ticket: value(TicketInput) },
    { ticket: given({ key: 1 }) },
    ["'ticket': ✖ Invalid input: expected string, received number\n  → at key"],
  ],
  [
    'two bindings with one INPUT_ name',
    { 'a-b': value(z.number()), a_b: value(z.number()) },
    { 'a-b': given(1), a_b: given(2) },
    ["'a-b' and 'a_b' both give INPUT_A_B"],
  ],
  [
    'a declared file name that is not a plain name',
    { spec: file('../spec.md') },
    { spec: fileAt(import.meta.path) },
    ["'spec' would be written to $STAGE_IN as '../spec.md', which is not a plain file name"],
  ],
] as const)('%s is a problem', (_, consumes, supplied, problems) => {
  expect(bindingProblems(consumes as Consumes, supplied as Record<string, Supplied>)).toEqual([...problems]);
});

test('a bound file that is missing, or is not a regular file, is a problem', () => {
  const dir = tempDir();
  const consumes: Consumes = { spec: file('spec.md'), plan: file('plan.md') };
  const missing = join(dir, 'missing.md');
  expect(bindingProblems(consumes, { spec: fileAt(missing), plan: fileAt(dir) })).toEqual([
    `'spec': no file at ${missing}`,
    `'plan': ${dir} is not a regular file`,
  ]);
});

test('two bindings written under one name in $STAGE_IN are a problem', () => {
  const s = scratch();
  const consumes: Consumes = { spec: file('ticket.json'), ticket: value(TicketInput) };
  const supplied = { spec: fileAt(s.source('t.json', '{}')), ticket: given({ key: 'FAKE-1' }) };
  expect(bindingProblems(consumes, supplied)).toEqual([
    "'spec' and 'ticket' are both written to $STAGE_IN as 'ticket.json'",
  ]);
});

test('every problem is reported, in consumes order, and materialise refuses to write any of them', () => {
  const s = scratch();
  const consumes: Consumes = {
    spec: file('spec.md'),
    ticket: value(TicketInput),
    note: value(z.string()),
    diff: gitDiff('HEAD~1'),
  };
  const supplied = { ticket: given({}), note: given('fine'), diff: given('x') };
  const problems = bindingProblems(consumes, supplied);
  expect(problems.map((problem) => problem.split(':')[0])).toEqual([
    "'spec' is required",
    "'ticket'",
    "'diff' is a gitDiff binding, which can't be supplied here",
  ]);
  expect(() => materialise(consumes, supplied, s.stageIn)).toThrow("'spec' is required");
  expect(readdirSync(s.stageIn)).toEqual([]);
  expect(existsSync(join(s.stageIn, 'note.txt'))).toBe(false);
});

test('prepared bindings hold each value as its schema parsed it, and write it into $STAGE_IN without parsing it again', () => {
  const s = scratch();
  let parses = 0;
  const Note = z.string().transform((text) => {
    parses++;
    return `${text}!`;
  });
  const consumes: Consumes = {
    note: value(Note),
    ticket: value(TicketInput),
    spec: file('spec.md'),
    hint: value(z.string()).optional(),
  };
  const supplied = {
    note: given('go'),
    ticket: given({ key: 'FAKE-1' }),
    spec: fileAt(s.source('draft.md', '# spec\n'), 'draft.md'),
  };
  const prepared = prepareBindings(consumes, supplied);
  expect(prepared.values).toEqual({ note: 'go!', ticket: { key: 'FAKE-1', labels: [] } });

  const { inputs, consumed } = materialisePrepared(prepared, s.stageIn);
  expect(inputs).toEqual({
    INPUT_NOTE: join(s.stageIn, 'note.txt'),
    INPUT_TICKET: join(s.stageIn, 'ticket.json'),
    INPUT_SPEC: join(s.stageIn, 'spec.md'),
  });
  expect(consumed).toEqual({ note: '--bind', ticket: '--bind', spec: 'draft.md', hint: null });
  const written = readdirSync(s.stageIn).sort();
  expect(Object.fromEntries(written.map((name) => [name, readFileSync(join(s.stageIn, name), 'utf8')]))).toEqual({
    'note.txt': 'go!',
    'spec.md': '# spec\n',
    'ticket.json': '{\n  "key": "FAKE-1",\n  "labels": []\n}\n',
  });
  expect(parses).toBe(1);
});

test('preparing bindings with a problem throws it, as materialise() does', () => {
  const consumes: Consumes = { ticket: value(TicketInput), spec: file('spec.md') };
  expect(() => prepareBindings(consumes, { ticket: given({ key: 7 }) })).toThrow("'spec' is required");
});
