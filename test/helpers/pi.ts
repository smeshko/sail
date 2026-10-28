// pi session events as the SDK hands them over (`session.subscribe`), in the shapes of a recorded session.
import type { PiEvent } from '../../src/adapters/pi/messages';
import type { PiSession, PiSessionFactory, PiSessionParams } from '../../src/adapters/pi/session';

export const PI_SESSION_ID = '0198f1c2-7d5b-7a3e-9a31-5b2f6a0c9d11';
export const PI_MODEL = 'groq/llama-3.3-70b-versatile';

export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

const usageOf = (usage: PiUsage = {}) => ({
  input: usage.input ?? 10,
  output: usage.output ?? 5,
  cacheRead: usage.cacheRead ?? 0,
  cacheWrite: usage.cacheWrite ?? 0,
  totalTokens: (usage.input ?? 10) + (usage.output ?? 5) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost ?? 0 },
});

export type PiBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; redacted?: boolean }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };

export const agentStart = (): PiEvent => ({ type: 'agent_start' });

export function assistantEnd(
  content: PiBlock[],
  usage?: PiUsage,
  extra: { stopReason?: string; errorMessage?: string } = {},
): PiEvent {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content,
      api: 'openai-completions',
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      usage: usageOf(usage),
      stopReason: extra.stopReason ?? (content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop'),
      ...(extra.errorMessage === undefined ? {} : { errorMessage: extra.errorMessage }),
      timestamp: 1_760_000_000_000,
    },
  };
}

export const toolStart = (toolCallId: string, toolName: string, args: Record<string, unknown>): PiEvent => ({
  type: 'tool_execution_start',
  toolCallId,
  toolName,
  args,
});

export const toolEnd = (toolCallId: string, toolName: string, text: string, isError = false): PiEvent => ({
  type: 'tool_execution_end',
  toolCallId,
  toolName,
  result: { content: [{ type: 'text', text }], details: undefined },
  isError,
});

export const turnEnd = (): PiEvent => ({ type: 'turn_end', message: {}, toolResults: [] });

// A scripted pi session: the factory the harness is given in place of the SDK, playing steps in order.
export type Step =
  | { act: 'emit'; event: PiEvent }
  | { act: 'submit'; params: unknown }
  | { act: 'gate'; id: string; name: string; input: unknown }
  | { act: 'bash'; command: string }
  | { act: 'waitForAbort' }
  | { act: 'throw'; message: string };

export interface ScriptedCall {
  readonly params: PiSessionParams;
  aborted: boolean;
  disposed: boolean;
  /** What the gate answered, per `gate` step. */
  readonly blocks: unknown[];
  /** What the submit tool replied, per `submit` step. */
  readonly replies: string[];
}

export function scriptedSessions(scripts: (prompt: string) => readonly Step[]) {
  const calls: ScriptedCall[] = [];
  const createSession: PiSessionFactory = async (params) => {
    const call: ScriptedCall = { params, aborted: false, disposed: false, blocks: [], replies: [] };
    calls.push(call);
    const listeners: ((event: PiEvent) => void)[] = [];
    const controller = new AbortController();
    let handler: ((event: { toolCallId: string; toolName: string; input: unknown }) => unknown) | undefined;
    params.gate({
      on: (_name, fn) => {
        handler = fn;
      },
    });
    const idle = () => new Promise<void>((done) => controller.signal.addEventListener('abort', () => done()));
    const session: PiSession = {
      sessionId: PI_SESSION_ID,
      systemPrompt: params.systemPrompt,
      subscribe(listener) {
        listeners.push(listener);
        return () => {
          listeners.splice(listeners.indexOf(listener), 1);
        };
      },
      async prompt(text) {
        for (const step of scripts(text)) {
          if (controller.signal.aborted) return;
          if (step.act === 'emit') {
            for (const listener of [...listeners]) listener(step.event);
          } else if (step.act === 'submit') {
            const reply = await params.submit.execute('submit-1', step.params);
            call.replies.push(reply.content.map((block) => block.text).join('\n'));
          } else if (step.act === 'gate') {
            call.blocks.push(handler?.({ toolCallId: step.id, toolName: step.name, input: step.input }));
          } else if (step.act === 'bash') {
            await params.bash
              .exec(step.command, params.cwd, { onData: () => undefined, signal: controller.signal })
              .catch(() => undefined);
          } else if (step.act === 'waitForAbort') {
            await idle();
          } else {
            throw new Error(step.message);
          }
        }
      },
      async abort() {
        call.aborted = true;
        controller.abort();
      },
      async dispose() {
        call.disposed = true;
      },
    };
    return session;
  };
  return { createSession, calls };
}
