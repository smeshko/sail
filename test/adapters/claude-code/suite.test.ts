// The shared Harness port suite against claude-code on a scripted transport: every verify runs it, with no network. Each
// world request names a prompt, and the transport plays that prompt's session (TASK-007).
import { describe, expect, test } from 'bun:test';
import { createClaudeCodeHarness } from '../../../src/adapters/claude-code/harness';
import { harnessSuite } from '../../ports/harness.suite';
import { assistant, blocked, done, failure, init, Probe, requestOf, scriptedQuery, success, text } from './helpers';

const USAGE = { input_tokens: 10, output_tokens: 2 };

const SCRIPTS = {
  done: {
    messages: [
      init(),
      assistant('msg_1', [text('Writing the spec.')], USAGE),
      success({ structured: done({ summary: 'Add a --shout flag.' }), cost: 0.001, usage: USAGE }),
    ],
  },
  blocked: {
    messages: [
      init(),
      success({ structured: blocked('The brief has no acceptance criteria.'), cost: 0.001, usage: USAGE }),
    ],
  },
  error: { messages: [init(), failure('error_during_execution', ['model overloaded'])] },
  'over-turns': { messages: [init(), failure('error_max_turns')] },
};

describe('claude-code (scripted)', () => {
  let probe = new Probe();
  const make = async () => {
    probe = new Probe();
    return {
      adapter: createClaudeCodeHarness({ query: scriptedQuery(SCRIPTS, probe), env: {}, now: () => 0 }),
      world: {
        done: requestOf({ key: 'spec#1', prompt: 'done' }),
        blocked: requestOf({ key: 'review#1', prompt: 'blocked' }),
        error: requestOf({ key: 'implement#1', prompt: 'error' }),
        overTurns: requestOf({ key: 'tests#1', prompt: 'over-turns' }),
      },
    };
  };

  harnessSuite('claude-code (scripted)', make);

  test('claude-code (scripted): an already-aborted request answers aborted without calling the SDK', async () => {
    const { adapter, world } = await make();
    const result = await adapter.run({ ...world.done, signal: AbortSignal.abort() });
    expect({ message: result.outcome === 'error' ? result.message : undefined, calls: probe.calls.length }).toEqual({
      message: 'aborted',
      calls: 0,
    });
  });
});
