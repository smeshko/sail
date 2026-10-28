// The typesafe Jev against the real System One: paid, and opt-in. The suite is not registered unless SAIL_LIVE_JEV=1,
// so `bun run verify` without the switch spends nothing:
//
//   SAIL_LIVE_JEV=1 bun run test test/adapters/jev/live.test.ts
import { expect, setDefaultTimeout, test } from 'bun:test';
import { createTypesafeJev } from '../../../src/adapters/jev/typesafe';
import { jevSuite, THREE_QUESTIONS } from '../../ports/jev.suite';

const LIVE = process.env.SAIL_LIVE_JEV === '1';

if (LIVE) {
  setDefaultTimeout(60_000);
  const apiKey = process.env.TYPESAFE_API_KEY ?? '';
  if (apiKey === '') throw new Error('the live suite needs TYPESAFE_API_KEY');

  jevSuite('typesafe live', async (emit) => createTypesafeJev({ apiKey, emit }));

  test('typesafe live: one choice, one score and one noul question are each answered with their own type', async () => {
    const answered = await createTypesafeJev({ apiKey }).ask(THREE_QUESTIONS);
    expect(answered.answers.area?.type).toBe('choice');
    expect(answered.answers.size?.type).toBe('score');
    expect(answered.answers.clear?.type).toBe('noul');
    expect(answered.latencyMs).toBeGreaterThan(0);
  });
}
