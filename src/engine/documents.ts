// Documents in the engine: what is wrong with a step's declaration of them, each template rendered into `$STAGE_OUT`
// before the session, and each produced document read with `Bun.markdown` and checked by its validators after it. A
// validator is a repository's code, so whatever it does, throwing included, becomes a problem of the try, never a crash
// and never a `result.json` its schema refuses.
//
// TDD stub (TASK-002): the signatures are final, and every body returns a wrong value of the right type.
import type { DerivedValue, Document, DocumentContent } from '../sdk/documents';
import type { ContractError, FileEntry } from './contract';
import type { RenderValues } from './render';

/** The most a produced document may hold for its validators to read it: it is read whole. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** The documents among a step's `produces`, as `[name, document]` in declaration order. */
export function documentsOf(produces: Readonly<Record<string, unknown>>): [string, Document][] {
  void produces;
  return [];
}

/**
 * What is wrong with a step's documents, found before it runs: a `produces` value that is neither `'file'` nor a
 * document, and a derived key two validators would both write.
 */
export function documentProblems(produces: Readonly<Record<string, unknown>>): string[] {
  void produces;
  return [];
}

/**
 * Reads a document's headings and top-level list items, as `Bun.markdown` parses them: fenced code holds neither, and
 * a nested list's items are not its parent's section's. A section runs from its heading to the next heading of the
 * same or a higher level.
 */
export function readDocument(name: string, text: string): DocumentContent {
  return { name, text, headings: [], sections: [], items: [] };
}

export interface RenderDocumentsOptions {
  produces: Readonly<Record<string, unknown>>;
  /** The stage directory: a template's path is relative to it. */
  stageDir: string;
  values: RenderValues;
  /** The try's `$STAGE_OUT`. */
  outDir: string;
}

/**
 * Renders each document's template into `outDir`, under the document's name, as a new file. It stops at the first that
 * can't be: its template can't be read or rendered, or the file can't be written.
 */
export function renderDocuments(options: RenderDocumentsOptions): { ok: true } | { ok: false; message: string } {
  void options;
  return { ok: true };
}

export interface ValidateDocumentsOptions {
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
  void options;
  return { validations: {}, derived: {}, errors: [] };
}
