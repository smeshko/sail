// A session's transcript, which the agent kind keeps as `session.log`: one block per event worth reading, in order,
// and how the session ended. It reads only sail's own events, so any harness can render its sessions with it.
import type { HarnessEvent } from '../../ports/harness';
import type { HarnessResult } from '../../ports/types';

export interface TranscriptEnd {
  readonly outcome: HarnessResult['outcome'];
  /** A blocked session's reason, or an error's message. */
  readonly message?: string;
  /** The usage is the provider's estimate, not its bill (D10). */
  readonly costEstimate?: boolean;
}

/** The longest a tool's input runs on its line. */
const INPUT_LENGTH = 200;

/** `text` as one block: every line after the first indented under it. */
const block = (text: string): string => text.split('\n').join('\n  ');

/** A tool's input on one line: compact JSON, which escapes every newline and control character, cut short. */
function inputOf(input: unknown): string {
  const json = JSON.stringify(input) ?? String(input);
  return json.length > INPUT_LENGTH ? `${json.slice(0, INPUT_LENGTH)}…` : json;
}

function lineOf(event: HarnessEvent): string | undefined {
  switch (event.type) {
    case 'harness:session_start':
      return `session ${event.sessionId} on ${event.model}`;
    case 'agent:message':
      return `assistant: ${block(event.text)}`;
    case 'agent:thinking':
      return `thinking: ${block(event.text)}`;
    case 'tool:start':
      return `tool ${event.tool} ${inputOf(event.input)} [${event.callId}]`;
    case 'tool:end':
      return `tool ${event.callId} ${event.status} in ${event.durationMs} ms`;
    case 'permission:denied':
      return `denied ${event.tool} [${event.callId}] by ${event.rule}: ${block(event.reason)}`;
    case 'usage:update': {
      const { input, cacheRead, cacheWrite, output } = event.tokens;
      return `usage: turn ${event.turn}, in ${input}, cache read ${cacheRead}, cache write ${cacheWrite}, out ${output}, $${event.costUsdSoFar}`;
    }
    case 'error:harness':
      return `error: ${block(event.message)}`;
    default:
      return undefined;
  }
}

export function renderTranscript(events: readonly HarnessEvent[], end?: TranscriptEnd): string {
  const lines: string[] = [];
  let lastUsage = -1;
  for (const event of events) {
    const line = lineOf(event);
    if (line === undefined) continue;
    if (event.type === 'usage:update') lastUsage = lines.length;
    lines.push(line);
  }
  if (end?.costEstimate === true && lastUsage >= 0) {
    lines[lastUsage] = `${lines[lastUsage]} (estimate: not the provider's bill)`;
  }
  if (end !== undefined)
    lines.push(`ended: ${end.outcome}${end.message === undefined ? '' : `: ${block(end.message)}`}`);
  return lines.join('\n');
}
