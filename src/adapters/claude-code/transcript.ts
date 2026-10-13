// Renders a session's events as the transcript session.log holds: one line per message in event order, a usage line per
// turn. The session start and end and the error events give no line. The agent kind writes the file from this text.
import type { HarnessEvent } from '../../ports/harness';

/** A provider whose cost is an estimate, which the header then says. */
export type EstimatedProvider = 'bedrock' | 'vertex';

const HEADER: Readonly<Record<EstimatedProvider, string>> = {
  bedrock: 'Cost is an estimate: Bedrock reports no session cost, so the costs below are estimated.',
  vertex: 'Cost is an estimate: Vertex reports no session cost, so the costs below are estimated.',
};

/** The line one event gives, or nothing. A tool's line is written when the call ends, and it names the tool by its start. */
function lineOf(event: HarnessEvent, tools: Map<string, string>): string | undefined {
  switch (event.type) {
    case 'agent:message':
      return `assistant: ${event.text}`;
    case 'agent:thinking':
      return `thinking: ${event.text}`;
    case 'tool:start':
      tools.set(event.callId, event.tool);
      return undefined;
    case 'tool:end':
      return `tool: ${tools.get(event.callId) ?? 'unknown'} ${event.status}`;
    case 'usage:update': {
      const { input, cacheRead, cacheWrite, output } = event.tokens;
      return `usage: turn ${event.turn}, ${input} in, ${cacheRead} cache read, ${cacheWrite} cache write, ${output} out, $${event.costUsdSoFar.toFixed(4)}`;
    }
    default:
      return undefined;
  }
}

/** One line per message in event order, usage lines last. A provider's estimate adds one header line first. */
export function renderTranscript(
  events: readonly HarnessEvent[],
  options: { provider?: EstimatedProvider } = {},
): string {
  const tools = new Map<string, string>();
  const lines = events.flatMap((event) => {
    const line = lineOf(event, tools);
    return line === undefined ? [] : [line];
  });
  if (options.provider !== undefined) lines.unshift(HEADER[options.provider]);
  return lines.join('\n');
}
