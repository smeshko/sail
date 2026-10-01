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
  /** One the agent reports blocked. */
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

export function harnessSuite(label: string, make: MakeHarness): void {
  test(`${label}: a completed session gives its result with a session id and usage, between session_start and session_end`, async () => {
    const { adapter, world } = await make();
    const { result, capture, types } = await run(adapter, world.done);
    expect(parseIssues(HarnessResult, result)).toEqual([]);
    expect(result.outcome).toBe('done');
    expect(result.sessionId).not.toBe('');
    expect([types[0], types.at(-1)]).toEqual(['harness:session_start', 'harness:session_end']);
    expect(eventIssues(capture.stamped(world.done.key))).toEqual([]);
  });

  test(`${label}: a blocked session gives its reason`, async () => {
    const { adapter, world } = await make();
    if (world.blocked === undefined) return;
    const { result } = await run(adapter, world.blocked);
    expect({ outcome: result.outcome, issues: parseIssues(HarnessResult, result) }).toEqual({
      outcome: 'blocked',
      issues: [],
    });
  });

  test(`${label}: a failed session resolves as error with its message, and emits error:harness`, async () => {
    const { adapter, world } = await make();
    if (world.error === undefined) return;
    const { result, capture, types } = await run(adapter, world.error);
    expect({ outcome: result.outcome, issues: parseIssues(HarnessResult, result) }).toEqual({
      outcome: 'error',
      issues: [],
    });
    expect(types).toContain('error:harness');
    expect(eventIssues(capture.stamped(world.error.key))).toEqual([]);
  });

  test(`${label}: a request whose signal is already aborted resolves as error`, async () => {
    const { adapter, world } = await make();
    const { result } = await run(adapter, { ...world.done, signal: AbortSignal.abort() });
    expect({ outcome: result.outcome, issues: parseIssues(HarnessResult, result) }).toEqual({
      outcome: 'error',
      issues: [],
    });
  });

  test(`${label}: a session over its maxTurns resolves as error, naming maxTurns`, async () => {
    const { adapter, world } = await make();
    if (world.overTurns === undefined) return;
    const { result } = await run(adapter, world.overTurns);
    expect(result.outcome === 'error' ? result.message : result.outcome).toContain('maxTurns');
  });

  test(`${label}: capabilities parse, with structured output, usage and abort, which every harness needs`, async () => {
    const { adapter } = await make();
    const capabilities = adapter.capabilities();
    expect(parseIssues(HarnessCapabilities, capabilities)).toEqual([]);
    const { structuredOutput, usage, abort } = capabilities;
    expect({ structuredOutput, usage, abort }).toEqual({ structuredOutput: true, usage: true, abort: true });
  });
}
