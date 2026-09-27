// journal.ndjson: the append-only record of every completed call, intake and step, one `sail.journal.v1` line each.
// A resume replays from it, so it is read strictly. A crash can tear only the line being written, so a torn last line
// is expected and left out. Any other malformed line means the journal can't be trusted, and reading it throws.
//
// Reads are stateless, with no writer object: the replay loop re-executes the workflow from the top, and a run appends
// once per call, so reading the file again before each append costs little.
import { readFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { appendLine, createFileOnce } from './durable';
import { formatIssue, validateDocument } from './schemas';

export const JOURNAL_FILE = 'journal.ndjson';

/** One journal line: a completed call, or a step inside one. Its `key` is `<stage>#<call>`, then `/<step>` for a step. */
export interface JournalEntry {
  seq: number;
  key: string;
  stage: string;
  call: number;
  step?: string;
  outcome: 'passed' | 'failed' | 'done' | 'blocked' | 'error';
  output: unknown;
  reason: string | null;
  files: Record<string, string>;
  /** Relative to the run directory. */
  resultPath: string;
  recordedAt: string;
}

/** What the engine appends. The journal numbers the entry and stamps its time. */
export type NewJournalEntry = Omit<JournalEntry, 'seq' | 'recordedAt'>;

/** A complete journal line that is malformed: the journal can't be trusted past it. */
export class JournalError extends Error {
  /** 1-based. */
  readonly line: number;

  constructor(path: string, line: number, why: string) {
    super(`${path}:${line} ${why}`);
    this.name = 'JournalError';
    this.line = line;
  }
}

interface Scanned {
  entries: JournalEntry[];
  torn: boolean;
  /** The byte length of the complete lines: where a torn tail starts. */
  complete: number;
}

function scan(path: string): Scanned {
  const text = readFileSync(path, 'utf8');
  const end = text.lastIndexOf('\n') + 1;
  const entries: JournalEntry[] = [];
  const lines = new Map<string, number>(); // key → the line that journaled it
  text
    .slice(0, end)
    .split('\n')
    .slice(0, -1)
    .forEach((line, i) => {
      const at = i + 1;
      const fail = (why: string) => new JournalError(path, at, why);
      // The writer never writes a blank line, so one means something else wrote to the journal.
      if (line.trim() === '') throw fail('is blank');
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch (error) {
        throw fail(`is not valid JSON: ${(error as Error).message}`);
      }
      const issues = validateDocument('sail.journal.v1', data);
      if (issues.length > 0) throw fail(`breaks sail.journal.v1: ${issues.map(formatIssue).join('; ')}`);
      const entry = data as JournalEntry;
      if (entry.seq !== at) throw fail(`has seq ${entry.seq}, and its place in the journal is ${at}`);
      const first = lines.get(entry.key);
      if (first !== undefined) throw fail(`repeats key '${entry.key}', journaled at line ${first}`);
      lines.set(entry.key, at);
      entries.push(entry);
    });
  return { entries, torn: end < text.length, complete: Buffer.byteLength(text.slice(0, end)) };
}

/** Creates the run's journal, empty. An existing one throws `EEXIST`. */
export function createJournal(runDir: string): void {
  createFileOnce(join(runDir, JOURNAL_FILE), '');
}

/**
 * Every complete entry, in order. `torn` says the bytes after the last newline are a line a crash cut short: they are
 * left out. Any complete line that doesn't parse, breaks `sail.journal.v1`, has a `seq` other than its place, or
 * repeats a key throws a `JournalError` naming it.
 */
export function readJournal(runDir: string): { entries: JournalEntry[]; torn: boolean } {
  const { entries, torn } = scan(join(runDir, JOURNAL_FILE));
  return { entries, torn };
}

/**
 * Appends `entry` as the next line, numbered after the last and stamped with `now`, and returns it as journaled. A
 * torn tail is cut off first, or the new line would be glued onto the fragment. A key already journaled throws, and so
 * does an entry that breaks `sail.journal.v1`, a bug in sail. Either way nothing is written.
 */
export function appendJournal(runDir: string, entry: NewJournalEntry, now: Date = new Date()): JournalEntry {
  const path = join(runDir, JOURNAL_FILE);
  const { entries, torn, complete } = scan(path);
  if (entries.some((journaled) => journaled.key === entry.key)) {
    throw new Error(`'${entry.key}' is already journaled in ${path}`);
  }
  const full: JournalEntry = { seq: entries.length + 1, ...entry, recordedAt: now.toISOString() };
  const issues = validateDocument('sail.journal.v1', full);
  if (issues.length > 0) {
    throw new Error(`a journal entry breaks sail.journal.v1, a bug in sail:\n${issues.map(formatIssue).join('\n')}`);
  }
  if (torn) truncateSync(path, complete);
  appendLine(path, JSON.stringify(full));
  return full;
}
