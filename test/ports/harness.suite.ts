// The Harness port suite: what every Harness adapter must do (ADR-0008). The fake runs it in
// test/adapters/fake/harness.test.ts, and a real adapter's test runs it against its provider on demand
// (SAIL_LIVE_HARNESS=1). A harness never rejects: every failure resolves as the `error` outcome. Every event it emits
// must validate against sail.event.v1 once stamped with the request's key.
import { expect, test } from 'bun:test';
import type { Harness, HarnessEvent, HarnessRequest } from '../../src/ports/harness';
import { HarnessCapabilities, HarnessResult } from '../../src/ports/types';
import { captureEvents, eventIssues, parseIssues } from '../helpers/ports';

/** The requests a suite run needs. Each one's `env.STAGE_OUT` is a directory of its own. */
export interface HarnessWorld {
  /** One the harness completes. */
  readonly done: HarnessRequest;
  /** One the agent reports blocked. Left out, and named unarranged, where that can't be arranged; as are the next two. */
  readonly blocked?: HarnessRequest;
  /** One the harness fails. */
  readonly error?: HarnessRequest;
  /** One that needs more turns than its budget allows. */
  readonly overTurns?: HarnessRequest;
}

export type MakeHarness = () => Promise<{ adapter: Harness; world: HarnessWorld }>;

/** Runs `request`, capturing its events. */
async function run(adapter: Harness, request: HarnessRequest) {
  const capture = captureEvents<HarnessEvent>();
  const result = await adapter.run({ ...request, onEvent: capture.emit });
  return { result, capture, types: capture.events.map((event) => event.type) };
}

/** The cases a world may be unable to arrange. */
type Optional = 'blocked' | 'error' | 'overTurns';

/** The world's request for `name`: a world leaves one out only when the suite is told it is unarranged. */
function arranged(world: HarnessWorld, name: Optional): HarnessRequest {
  const request = world[name];
  if (request === undefined) throw new Error(`no ${name} in the world, and none named unarranged`);
  return request;
}

/**
 * Runs the suite. A case the world can't arrange is named in `unarranged`, and shows as skipped: a world that leaves
 * one out without naming it fails that case.
 */
export function harnessSuite(label: string, make: MakeHarness, unarranged: readonly Optional[] = []): void {
  test(`${label}: a completed session gives its result with a session id and usage, between session_start and session_end`, async () => {
    const { adapter, world } = await make();
    const { result, capture, types } = await run(adapter, world.done);
    expect(parseIssues(HarnessResult, result)).toEqual([]);
    expect(result.outcome).toBe('done');
    expect(result.sessionId).not.toBe('');
    expect([types[0], types.at(-1)]).toEqual(['harness:session_start', 'harness:session_end']);
    expect(eventIssues(capture.stamped(world.done.key))).toEqual([]);
  });

  test(`${label}: a session ends once, reporting its result's outcome, session id and usage`, async () => {
    const { adapter, world } = await make();
    const { result, capture } = await run(adapter, world.done);
    const ends = capture.events.flatMap((event) => (event.type === 'harness:session_end' ? [event] : []));
    expect(ends.map(({ outcome, sessionId, usage }) => ({ outcome, sessionId, usage }))).toEqual([
      { outcome: result.outcome, sessionId: result.sessionId, usage: result.usage },
    ]);
  });

  test.skipIf(unarranged.includes('blocked'))(`${label}: a blocked session gives its reason`, async () => {
    const { adapter, world } = await make();
    const { result } = await run(adapter, arranged(world, 'blocked'));
    expect({ outcome: result.outcome, issues: parseIssues(HarnessResult, result) }).toEqual({
      outcome: 'blocked',
      issues: [],
    });
  });

  test.skipIf(unarranged.includes('error'))(
    `${label}: a failed session resolves as error with its message, and emits error:harness`,
    async () => {
      const { adapter, world } = await make();
      const request = arranged(world, 'error');
      const { result, capture, types } = await run(adapter, request);
      expect({ outcome: result.outcome, issues: parseIssues(HarnessResult, result) }).toEqual({
        outcome: 'error',
        issues: [],
      });
      expect(types).toContain('error:harness');
      expect(eventIssues(capture.stamped(request.key))).toEqual([]);
    },
  );

  test(`${label}: a session aborted while it runs, from its first event, resolves as error and still ends`, async () => {
    const { adapter, world } = await make();
    const controller = new AbortController();
    const types: string[] = [];
    const result = await adapter.run({
      ...world.done,
      signal: controller.signal,
      onEvent: (event) => {
        types.push(event.type);
        controller.abort();
      },
    });
    expect({ outcome: result.outcome, issues: parseIssues(HarnessResult, result) }).toEqual({
      outcome: 'error',
      issues: [],
    });
    expect(types.at(-1)).toBe('harness:session_end');
  });

  test(`${label}: a request whose signal is already aborted resolves as error`, async () => {
    const { adapter, world } = await make();
    const { result } = await run(adapter, { ...world.done, signal: AbortSignal.abort() });
    expect({ outcome: result.outcome, issues: parseIssues(HarnessResult, result) }).toEqual({
      outcome: 'error',
      issues: [],
    });
  });

  test.skipIf(unarranged.includes('overTurns'))(
    `${label}: a session over its maxTurns resolves as error, naming maxTurns`,
    async () => {
      const { adapter, world } = await make();
      const { result } = await run(adapter, arranged(world, 'overTurns'));
      expect(result.outcome === 'error' ? result.message : result.outcome).toContain('maxTurns');
    },
  );

  test(`${label}: capabilities parse, with structured output, usage and abort, which every harness needs`, async () => {
    const { adapter } = await make();
    const capabilities = adapter.capabilities();
    expect(parseIssues(HarnessCapabilities, capabilities)).toEqual([]);
    const { structuredOutput, usage, abort } = capabilities;
    expect({ structuredOutput, usage, abort }).toEqual({ structuredOutput: true, usage: true, abort: true });
  });
}
