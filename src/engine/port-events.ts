// The port events file: `port-events.ndjson` in a script step's call directory, where a `sail port` the script runs
// leaves the provider events its adapter emitted. `SAIL_EVENTS` names it. The child appends one line per event, with no
// envelope, and the script kind reads the file once the script has ended and emits each event under the step's key.
//
// What a line must be is decided here alone: a JSON object whose type is a `ticket:*` or `codehost:*` event, with none
// of the fields the run stamps, that validates against `sail.event.v1` once enveloped. A script can write the file
// itself, so nothing else is taken from it. A `workspace:*` event carries no key, and no port command emits one.
import { appendFileSync, closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import type { PortErrorEvent, ProviderEvent } from '../events/types';
import { validateDocument } from './schemas';

export const PORT_EVENTS_FILE = 'port-events.ndjson';

/** The fields the run stamps on an event: a line that carries one is refused. */
const STAMPED = ['seq', 'ts', 'runId', 'key'] as const;

/** What a port command leaves in the file: a provider event, or a failed call. */
export type PortEvent = ProviderEvent | PortErrorEvent;

/** Appends `event` to the file at `path` as one line, in one write. The file's directory must exist. */
export function appendPortEvent(path: string, event: PortEvent): void {
  appendFileSync(path, `${JSON.stringify(event)}\n`);
}

/** The provider event `line` holds, or why it holds none. */
function parseLine(line: string, envelope: { runId: string; key: string }): ProviderEvent | string {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return 'it is not JSON';
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'it is not a JSON object';
  const stamped = STAMPED.find((field) => Object.hasOwn(data, field));
  if (stamped !== undefined) return `it carries ${stamped}, which the run stamps`;
  const { type } = data as { type?: unknown };
  if (typeof type !== 'string' || !(type.startsWith('ticket:') || type.startsWith('codehost:'))) {
    return `its type ${JSON.stringify(type) ?? 'is missing: it'} is no ticket:* or codehost:* event`;
  }
  const enveloped = { seq: 1, ts: new Date(0).toISOString(), ...envelope, ...data };
  const issues = validateDocument('sail.event.v1', enveloped);
  if (issues.length > 0) return issues.map((issue) => `${issue.path} ${issue.message}`).join('; ');
  return data as ProviderEvent;
}

/**
 * The provider events the file at `path` holds, in order, and a problem for each whole line that is none:
 * `port-events.ndjson line <n> is not a provider event: <why>`. The valid lines around a bad one are still given. A
 * last line with no newline is left out: a child was killed while writing it. A file that isn't there holds nothing,
 * and one that is no regular file is a problem, unread.
 */
export function readPortEvents(
  path: string,
  envelope: { runId: string; key: string },
): { events: PortEvent[]; problems: string[] } {
  let text: string;
  try {
    // Opened without blocking and looked at before it is read: a script can leave a FIFO here, whose read would never
    // return, or a link to a device, whose read would never end. A directory is refused by the read itself.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() && !stat.isDirectory()) {
        return { events: [], problems: [`${PORT_EVENTS_FILE} is not a regular file`] };
      }
      text = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    return { events: [], problems: code === 'ENOENT' ? [] : [`${PORT_EVENTS_FILE} can't be read (${code})`] };
  }
  const events: PortEvent[] = [];
  const problems: string[] = [];
  const lines = text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .slice(0, -1);
  lines.forEach((line, index) => {
    const parsed = parseLine(line, envelope);
    if (typeof parsed === 'string')
      problems.push(`${PORT_EVENTS_FILE} line ${index + 1} is not a provider event: ${parsed}`);
    else events.push(parsed);
  });
  return { events, problems };
}
