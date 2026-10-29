// Documents in the engine: what is wrong with a step's declaration of them, each template rendered into `$STAGE_OUT`
// before the session, and each produced document read with `Bun.markdown` and checked by its validators after it. A
// validator is a repository's code, so whatever it does, throwing included, becomes a problem of the try, never a crash
// and never a `result.json` its schema refuses.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  DerivedValue,
  Document,
  DocumentContent,
  DocumentHeading,
  DocumentItem,
  DocumentSection,
  Validator,
} from '../sdk/documents';
import { placeholderNames } from '../sdk/documents';
import type { ContractError, FileEntry } from './contract';
import { type RenderValues, render } from './render';

/** The most a produced document may hold for its validators to read it: it is read whole. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

/**
 * The most problems one check of a document reports: the rest are counted. Each goes into `result.json` and the
 * corrective try's prompt, so a document full of one mistake must not make either huge.
 */
export const MAX_PROBLEMS_PER_CHECK = 20;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code ?? messageOf(error);

/** Whether `value` is a document: `doc()` makes one, and a hand-built one has the same shape. */
function isDocument(value: unknown): value is Document {
  if (typeof value !== 'object' || value === null) return false;
  const { kind, template, validators } = value as Partial<Document>;
  return kind === 'document' && typeof template === 'string' && Array.isArray(validators);
}

/** Whether `value` is a validator, as `doc()` checks one: a hand-built document's validators are checked here. */
function isValidator(value: unknown): value is Validator {
  if (typeof value !== 'object' || value === null) return false;
  const { check, derives, validate } = value as Partial<Validator>;
  return (
    typeof check === 'string' &&
    check !== '' &&
    Array.isArray(derives) &&
    derives.every((key) => typeof key === 'string' && key !== '') &&
    typeof validate === 'function'
  );
}

/** The documents among a step's `produces`, as `[name, document]` in declaration order. */
export function documentsOf(produces: Readonly<Record<string, unknown>>): [string, Document][] {
  return Object.entries(produces).filter((entry): entry is [string, Document] => isDocument(entry[1]));
}

/**
 * What is wrong with a step's documents, found before it runs: a `produces` value that is neither `'file'` nor a
 * document, and a derived key two validators would both write.
 */
export function documentProblems(produces: Readonly<Record<string, unknown>>): string[] {
  const found: string[] = [];
  /** Each derived key, and the document and check that first derives it. */
  const first = new Map<string, string>();
  for (const [name, value] of Object.entries(produces)) {
    if (value === 'file') continue;
    if (!isDocument(value)) {
      found.push(`'${name}' is neither 'file' nor a document`);
      continue;
    }
    for (const [index, validator] of value.validators.entries()) {
      if (!isValidator(validator)) {
        found.push(
          `'${name}' validator ${index} is not a validator: it needs a check label, the keys it derives and a validate function`,
        );
        continue;
      }
      const here = `'${name}' (${validator.check})`;
      for (const key of validator.derives) {
        const earlier = first.get(key);
        if (earlier === undefined) first.set(key, here);
        else found.push(`derived key '${key}' comes from both ${earlier} and ${here}`);
      }
    }
  }
  return found;
}

/**
 * Reads a document's headings and top-level list items, as `Bun.markdown` parses them: fenced code holds neither, and
 * a nested list's items are not its parent's section's. A section runs from its heading to the next heading of the
 * same or a higher level.
 */
export function readDocument(name: string, text: string, placeholders: readonly string[]): DocumentContent {
  // Bun calls an element's callback after its children's, so a heading inside a list item comes before the item. Each
  // callback returns a token for its mark instead, in front of its children, and the rendered text holds the tokens in
  // the document's order. The nonce keeps a document's own text, code included, from passing for a token.
  type Mark = { heading: DocumentHeading } | { item: DocumentItem };
  const found: Mark[] = [];
  const nonce = Bun.randomUUIDv7();
  const token = (mark: Mark) => `\u0000${nonce}:${found.push(mark) - 1}\u0000`;
  const rendered = Bun.markdown.render(text, {
    heading: (children, meta) => token({ heading: { text: children.trim(), level: meta.level } }),
    listItem: (children, meta) =>
      meta.depth === 0
        ? token({ item: typeof meta.checked === 'boolean' ? { checked: meta.checked } : {} }) + children
        : children,
  });
  const marks = [...rendered.matchAll(new RegExp(`\u0000${nonce}:(\\d+)\u0000`, 'g'))].map(
    (match) => found[Number(match[1])] as Mark,
  );
  const headings: DocumentHeading[] = [];
  const sections: DocumentSection[] = [];
  const items: DocumentItem[] = [];
  /** The sections still open: each takes every item until a heading of its level or a higher one closes it. */
  let open: DocumentSection[] = [];
  for (const mark of marks) {
    if ('item' in mark) {
      items.push(mark.item);
      for (const section of open) (section.items as DocumentItem[]).push(mark.item);
      continue;
    }
    const { heading } = mark;
    headings.push(heading);
    open = open.filter((section) => section.level < heading.level);
    const section: DocumentSection = { heading: heading.text, level: heading.level, items: [] };
    sections.push(section);
    open.push(section);
  }
  // Every validator of the document is handed this one reading, so none may change what the next one reads.
  for (const each of [...headings, ...items]) Object.freeze(each);
  for (const section of sections) Object.freeze(Object.freeze(section).items);
  return Object.freeze({
    name,
    text,
    placeholders: Object.freeze([...placeholders]),
    headings: Object.freeze(headings),
    sections: Object.freeze(sections),
    items: Object.freeze(items),
  });
}

export interface RenderDocumentsOptions {
  produces: Readonly<Record<string, unknown>>;
  /** The stage directory: a template's path is relative to it. */
  stageDir: string;
  values: RenderValues;
  /** The try's `$STAGE_OUT`. */
  outDir: string;
  /**
   * Replaces a file already there: a step's `$STAGE_OUT` is its call's, which an earlier try of the step wrote to. A
   * one-step call's try writes into a new directory, where any file already there is a bug.
   */
  replace?: boolean;
}

/**
 * Renders each document's template into `outDir`, under the document's name, as a new file. It stops at the first that
 * can't be: its template can't be read or rendered, or the file can't be written.
 */
export function renderDocuments(
  options: RenderDocumentsOptions,
): { ok: true; placeholders: Record<string, string[]> } | { ok: false; message: string } {
  const placeholders: Record<string, string[]> = {};
  for (const [name, document] of documentsOf(options.produces)) {
    const of = `'${name}': template ${document.template}`;
    let template: string;
    try {
      template = readFileSync(resolve(options.stageDir, document.template), 'utf8');
    } catch (error) {
      return { ok: false, message: `${of} can't be read (${codeOf(error)})` };
    }
    placeholders[name] = placeholderNames(template);
    let text: string;
    try {
      text = render(template, options.values).text;
    } catch (error) {
      return { ok: false, message: `${of}: ${messageOf(error)}` };
    }
    try {
      // A try's directory is new, so a file already there is a bug, unless `$STAGE_OUT` is shared and an earlier try
      // of the step left it: that one is replaced, never written through.
      const path = join(options.outDir, name);
      if (options.replace) rmSync(path, { force: true, recursive: true });
      writeFileSync(path, text, { flag: 'wx' });
    } catch (error) {
      return { ok: false, message: `${of} can't be written to $STAGE_OUT (${codeOf(error)})` };
    }
  }
  return { ok: true, placeholders };
}

/** A value `result.json`'s `derived` can hold: a finite number, a string, a boolean, or a list of them. */
function isDerivedValue(value: unknown): value is DerivedValue {
  const scalar = (each: unknown) =>
    typeof each === 'string' || typeof each === 'boolean' || (typeof each === 'number' && Number.isFinite(each));
  return scalar(value) || (Array.isArray(value) && value.every(scalar));
}

/** What a validator found, guarded: whatever it throws or returns becomes problems and derived facts. */
function judge(
  validator: Validator,
  content: DocumentContent,
): { problems: string[]; derived: [string, DerivedValue][] } {
  let verdict: unknown;
  try {
    verdict = validator.validate(content);
  } catch (error) {
    return { problems: [`threw: ${messageOf(error)}`], derived: [] };
  }
  const { problems, derived } = (typeof verdict === 'object' && verdict !== null ? verdict : {}) as {
    problems?: unknown;
    derived?: unknown;
  };
  if (!Array.isArray(problems) || !problems.every((problem) => typeof problem === 'string')) {
    return { problems: ['returned no verdict: a verdict lists its problems'], derived: [] };
  }
  const found: string[] = [...problems];
  const kept: [string, DerivedValue][] = [];
  if (derived !== undefined && (typeof derived !== 'object' || derived === null || Array.isArray(derived))) {
    found.push('derived something other than facts by key');
  } else {
    for (const [key, value] of Object.entries(derived ?? {})) {
      if (!validator.derives.includes(key)) found.push(`derived '${key}', which it doesn't declare`);
      else if (!isDerivedValue(value)) found.push(`derived '${key}' as a value result.json can't hold`);
      else kept.push([key, value]);
    }
  }
  if (found.length <= MAX_PROBLEMS_PER_CHECK) return { problems: found, derived: kept };
  const more = found.length - MAX_PROBLEMS_PER_CHECK;
  const tail = `and ${more} more problem${more === 1 ? '' : 's'}`;
  return { problems: [...found.slice(0, MAX_PROBLEMS_PER_CHECK), tail], derived: kept };
}

export interface ValidateDocumentsOptions {
  placeholders: Record<string, string[]>;
  produces: Readonly<Record<string, unknown>>;
  /** The files the try recorded: a document it didn't produce is a missing file, and isn't validated. */
  files: Readonly<Record<string, FileEntry>>;
  /** The try's `$STAGE_OUT`. */
  outDir: string;
}

export interface Validated {
  /** Each validated document's verdict, by name, in declaration order. */
  validations: Record<string, { ok: boolean; checks: string[] }>;
  /** Every fact the validators derived. */
  derived: Record<string, DerivedValue>;
  /** One `invalid_output` per problem, as `<name>: <check>: <problem>`. */
  errors: ContractError[];
}

/** Runs every validator of each document the try produced, all of them even after one fails, in declaration order. */
export function validateDocuments(options: ValidateDocumentsOptions): Validated {
  const validations: [string, { ok: boolean; checks: string[] }][] = [];
  const derived: [string, DerivedValue][] = [];
  const errors: ContractError[] = [];
  for (const [name, document] of documentsOf(options.produces)) {
    const entry = options.files[name];
    if (entry === undefined || !Object.hasOwn(options.files, name)) continue;
    const refuse = (message: string) => {
      errors.push({ reason: 'invalid_output', message: `${name}: ${message}` });
      validations.push([name, { ok: false, checks: [] }]);
    };
    if (entry.bytes > MAX_DOCUMENT_BYTES) {
      refuse(`is ${entry.bytes} bytes, more than the 1 MiB a document may hold to be validated`);
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(options.outDir, name), 'utf8');
    } catch (error) {
      refuse(`can't be read (${codeOf(error)})`);
      continue;
    }
    const content = readDocument(name, text, options.placeholders[name] ?? []);
    let ok = true;
    for (const validator of document.validators) {
      const verdict = judge(validator, content);
      for (const problem of verdict.problems) {
        errors.push({ reason: 'invalid_output', message: `${name}: ${validator.check}: ${problem}` });
      }
      ok &&= verdict.problems.length === 0;
      derived.push(...verdict.derived);
    }
    validations.push([name, { ok, checks: document.validators.map((validator) => validator.check) }]);
  }
  return { validations: Object.fromEntries(validations), derived: Object.fromEntries(derived), errors };
}
