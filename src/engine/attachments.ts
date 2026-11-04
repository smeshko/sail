// A ticket's uploaded files on disk: the safe name each lands under, and the download of every file the ticket source
// hosts into one directory. Shared by the ticket intake and `sail port ticket-source download`.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { PortError } from '../ports/errors';
import type { TicketSource } from '../ports/ticket-source';
import type { Attachment } from '../ports/types';

/** What became of one attachment: the file it was saved as under the directory, or why it wasn't, or that it is a link. */
export interface AttachmentOutcome {
  readonly name: string;
  readonly url: string;
  readonly mimeType?: string;
  /** The file's name inside the directory. */
  readonly file?: string;
  readonly skipped?: string;
  /** The source doesn't host it: a link, never fetched. */
  readonly link?: boolean;
}

const MAX_NAME = 100;

/**
 * A name a file can be saved under inside one directory, from a name the ticket gave it: path separators, `.` and `..`
 * segments, control characters and `:*?"<>|` can't survive, a leading dot is dropped, and the name is cut to 100
 * characters keeping its extension. A name left empty is `attachment-<index>`. `taken` holds the names (lower case)
 * already used; the result is not among them, and is added.
 */
export function safeFileName(name: string, taken: Set<string>, index: number): string {
  const cleaned = name
    .split(/[\\/]/)
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join('_')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
    .replace(/[\x00-\x1f\x7f:*?"<>|]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '');
  const base = cleaned === '' ? `attachment-${index}` : cleaned;
  const ext = extname(base).length <= 20 ? extname(base) : '';
  const stem = base.slice(0, base.length - ext.length).slice(0, MAX_NAME - ext.length);
  let candidate = `${stem}${ext}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** The part of a PortError's message after `port.op: `. */
const reasonOf = (error: PortError): string => error.message.slice(error.message.indexOf(': ') + 2);

/**
 * Downloads each attachment the source hosts into `dir`, and lists what became of every one, in order. A link is
 * listed and never fetched. A file the source refuses (a PortError) is skipped with its reason, so one bad file ends
 * nothing. Each file is created new under a name `safeFileName()` made and no file already in `dir` has, so nothing is
 * overwritten and no link is followed. `dir` is made when the first file is written. An abort of `signal`, and any error
 * that is no PortError, rethrow.
 */
export async function downloadAttachments(
  source: TicketSource,
  ticketKey: string,
  attachments: readonly Attachment[],
  dir: string,
  signal?: AbortSignal,
): Promise<AttachmentOutcome[]> {
  const taken = new Set<string>(existsSync(dir) ? readdirSync(dir).map((each) => each.toLowerCase()) : []);
  const outcomes: AttachmentOutcome[] = [];
  for (const [i, attachment] of attachments.entries()) {
    const { name, url, mimeType } = attachment;
    const entry = { name, url, ...(mimeType === undefined ? {} : { mimeType }) };
    if (!source.hosts(url)) {
      outcomes.push({ ...entry, link: true });
      continue;
    }
    try {
      const downloaded = await source.download(ticketKey, url, signal === undefined ? {} : { signal });
      const file = safeFileName(name, taken, i + 1);
      const path = resolve(dir, file);
      if (dirname(path) !== resolve(dir)) throw new Error(`${file} does not sit directly inside ${dir}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, downloaded.bytes, { flag: 'wx' });
      outcomes.push({ ...entry, file });
    } catch (error) {
      if (!(error instanceof PortError) || signal?.aborted) throw error;
      const reason = reasonOf(error);
      outcomes.push({
        ...entry,
        skipped: /over the .* cap$/.test(reason)
          ? `${name}: ${reason}, not downloaded`
          : `${name}: not downloaded: ${reason}`,
      });
    }
  }
  return outcomes;
}
