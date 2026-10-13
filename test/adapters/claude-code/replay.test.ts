// The recorded SDK stream replays through the harness to the events it implies. The stream is the fixture
// test/fixtures/claude-code/session.jsonl: one SDK message per line, with no private path or key in it (TASK-007).
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClaudeCodeHarness } from '../../../src/adapters/claude-code/harness';
import type { SDKMessage } from '../../../src/adapters/claude-code/sdk';
import type { HarnessEvent } from '../../../src/ports/harness';
import { captureEvents } from '../../helpers/ports';
import { requestOf, scriptedQuery, typesOf } from './helpers';

const STREAM = readFileSync(join(import.meta.dir, '../../fixtures/claude-code/session.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as SDKMessage);

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('the recorded stream replays to its session start, tool start, tool end and session end, and to its done result', async () => {
    const capture = captureEvents<HarnessEvent>();
    const harness = createClaudeCodeHarness({
      query: scriptedQuery({ replay: { messages: STREAM } }),
      env: {},
      now: () => 0,
    });
    const result = await harness.run(requestOf({ key: 'spec#1', prompt: 'replay', onEvent: capture.emit }));
    const types = typesOf(capture.events);
    expect({
      outcome: result.outcome,
      sessionId: result.sessionId,
      start: types[0],
      end: types.at(-1),
      tools: capture.events.filter((event) => event.type === 'tool:start' || event.type === 'tool:end').map((event) =>
        event.type === 'tool:start' ? `start ${event.tool}` : `end ${event.status}`,
      ),
    }).toEqual({
      outcome: 'done',
      sessionId: '5d1f3c2e-8a4b-4c3d-9e2f-0a1b2c3d4e5f',
      start: 'harness:session_start',
      end: 'harness:session_end',
      tools: ['start Read', 'end completed'],
    });
  });
