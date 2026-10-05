// Harness doubles for the agent step's tests. scripted() plays sessions a test writes out, as any repository's own
// adapter might behave: it may emit anything, resolve with anything or reject. recording() wraps a real harness, such
// as the fake, and keeps each request it received.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Harness, HarnessEvent, HarnessRequest } from '../../src/ports/harness';
import type { HarnessResult } from '../../src/ports/types';

/** One session of the scripted harness. */
export interface Scripted {
  /** What `run()` resolves with: anything at all, as a repository's own adapter may. An Error is thrown instead. */
  resolves: unknown;
  /** Emitted in order before the session resolves. */
  emits?: readonly HarnessEvent[];
  /** File name → text, written into the request's `$STAGE_OUT` before the session resolves. */
  files?: Record<string, string>;
}

/** A harness with the requests it has received, in order. */
export type Recorded = Harness & { readonly requests: HarnessRequest[] };

const CAPABILITIES = { structuredOutput: true, permissions: true, usage: true, abort: true, budgets: [] };

/** A harness named `scripted` that plays `sessions` in order, and the last one again after that. */
export function scripted(...sessions: Scripted[]): Recorded {
  const requests: HarnessRequest[] = [];
  return {
    name: 'scripted',
    requests,
    capabilities: () => CAPABILITIES,
    async run(request) {
      requests.push(request);
      const played = sessions[Math.min(requests.length, sessions.length) - 1] as Scripted;
      for (const event of played.emits ?? []) request.onEvent?.(event);
      for (const [name, text] of Object.entries(played.files ?? {})) {
        writeFileSync(join(request.env.STAGE_OUT ?? '', name), text);
      }
      if (played.resolves instanceof Error) throw played.resolves;
      return played.resolves as HarnessResult;
    },
  };
}

/** A harness named `scripted` whose `run()` throws `error` itself, where a harness should return a promise. */
export function throwing(error: Error): Harness {
  return {
    name: 'scripted',
    capabilities: () => CAPABILITIES,
    run: () => {
      throw error;
    },
  };
}

export interface RecordingHooks {
  /** Called as a session starts, with its request and how many came before it. */
  before?(request: HarnessRequest, earlier: number): void;
  /** Called once a session has resolved, before its caller hears of it. */
  after?(request: HarnessRequest, result: HarnessResult): void;
}

/** `harness`, keeping each request it received. `hooks` let a test act as a session starts or ends. */
export function recording(harness: Harness, hooks: RecordingHooks = {}): Recorded {
  const requests: HarnessRequest[] = [];
  return {
    name: harness.name,
    requests,
    capabilities: () => harness.capabilities(),
    async run(request) {
      hooks.before?.(request, requests.length);
      requests.push(request);
      const result = await harness.run(request);
      hooks.after?.(request, result);
      return result;
    },
  };
}
