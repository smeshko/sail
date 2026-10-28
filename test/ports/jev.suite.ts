// The Jev port suite: what every Jev adapter must do. The fake runs it in test/adapters/fake/jev.test.ts, typesafe runs
// it offline on a scripted API, and against TypeSafe itself on demand (SAIL_LIVE_JEV=1). Each case starts from a fresh
// make(), and every event it captures must validate against sail.event.v1, with a call's key and without one.
import { expect, test } from 'bun:test';
import type { ProviderEmit, ProviderEvent } from '../../src/events/types';
import type { Jev } from '../../src/ports/jev';
import { JevAnswered, JevCapabilities, type JevRequest } from '../../src/ports/types';
import { captureEvents, eventIssues, parseIssues, settle } from '../helpers/ports';

export type MakeJev = (emit: ProviderEmit) => Promise<Jev>;

/** One question of each type about a state. */
export const THREE_QUESTIONS: JevRequest = {
  state: 'A ticket asks to add dark mode.',
  questions: {
    area: {
      type: 'choice',
      instructions: 'Which area does the ticket touch most?',
      criteria: { ui: 'the user interface', backend: 'the server' },
    },
    size: {
      type: 'score',
      instructions: 'How large is the change?',
      criteria: ['small', 'medium', 'large'],
    },
    clear: {
      type: 'noul',
      instructions: 'Is the request clear enough to build?',
      criteria: { true: 'it is clear', false: 'it is not' },
    },
  },
};

/** Every captured event validates against sail.event.v1, stamped with a call's key and without one. */
function expectValidEvents(capture: { stamped(key?: string): Record<string, unknown>[] }): void {
  expect(eventIssues(capture.stamped('ask#1'))).toEqual([]);
  expect(eventIssues(capture.stamped())).toEqual([]);
}

export function jevSuite(label: string, make: MakeJev): void {
  const start = async () => {
    const capture = captureEvents();
    return { capture, adapter: await make(capture.emit) };
  };

  test(`${label}: a choice, a score and a noul question are answered by name, each with its type`, async () => {
    const { adapter } = await start();
    const answered = await adapter.ask(THREE_QUESTIONS);
    expect(parseIssues(JevAnswered, answered)).toEqual([]);
    expect(Object.keys(answered.answers).sort()).toEqual(['area', 'clear', 'size']);
    expect(answered.answers.area?.type).toBe('choice');
    expect(answered.answers.size?.type).toBe('score');
    expect(answered.answers.clear?.type).toBe('noul');
    const area = answered.answers.area;
    expect(area?.type === 'choice' && ['ui', 'backend'].includes(area.choice)).toBe(true);
  });

  test(`${label}: ask emits jev:asked with the model and the number of questions`, async () => {
    const { adapter, capture } = await start();
    const answered = await adapter.ask(THREE_QUESTIONS);
    const events = capture.events as Extract<ProviderEvent, { type: 'jev:asked' }>[];
    expect(events.map(({ type, model, questions }) => ({ type, model, questions }))).toEqual([
      { type: 'jev:asked', model: answered.model, questions: 3 },
    ]);
    expectValidEvents(capture);
  });

  test(`${label}: a request without a question is refused invalid, and nothing is emitted`, async () => {
    const { adapter, capture } = await start();
    const outcome = await settle(adapter.ask({ state: 'x', questions: {} }));
    expect(outcome).toEqual({ rejected: { port: 'jev', op: 'ask', code: 'invalid' } });
    expect(capture.events).toEqual([]);
  });

  test(`${label}: a choice question with no option is refused invalid`, async () => {
    const { adapter } = await start();
    const outcome = await settle(
      adapter.ask({ state: 'x', questions: { q: { type: 'choice', instructions: 'which?', criteria: {} } } }),
    );
    expect(outcome).toEqual({ rejected: { port: 'jev', op: 'ask', code: 'invalid' } });
  });

  test(`${label}: capabilities lists the question types`, async () => {
    const { adapter } = await start();
    expect(parseIssues(JevCapabilities, adapter.capabilities())).toEqual([]);
    expect([...adapter.capabilities().questionTypes].sort()).toEqual(['choice', 'noul', 'score']);
  });
}
