// The fake Jev: the port suite, then what only the fake does: answers from a seed, defaults, and a seeded error status.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeJev } from '../../../src/adapters/fake/jev';
import { PortError } from '../../../src/ports/errors';
import { captureEvents, rejection } from '../../helpers/ports';
import { jevSuite, THREE_QUESTIONS } from '../../ports/jev.suite';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A seed file holding `seed` as JSON (or as given text), and its path. A missing file when `seed` is undefined. */
function seedFile(seed?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-fake-jev-'));
  dirs.push(dir);
  const path = join(dir, 'jev.json');
  if (seed !== undefined) writeFileSync(path, typeof seed === 'string' ? seed : JSON.stringify(seed));
  return path;
}

jevSuite('fake', async (emit) => createFakeJev({ seed: seedFile(), emit }));

test('with no seed, each question gets its default answer: the first option, the first level, and a noul of 1', async () => {
  const jev = createFakeJev({ seed: seedFile() });
  const answered = await jev.ask(THREE_QUESTIONS);
  expect(answered.model).toBe('jev-latest');
  expect(answered.answers).toEqual({
    area: { type: 'choice', choice: 'ui', confidence: 1, probabilities: { ui: 1, backend: 0 } },
    size: { type: 'score', score: 0, confidence: 1 },
    clear: { type: 'noul', noul: 1 },
  });
});

test('a seeded answer is returned as given, with the seeded usage and model', async () => {
  const seed = seedFile({
    model: 'jev-seeded',
    usage: { inputTokens: 12, outputTokens: 3 },
    answers: { area: { type: 'choice', choice: 'backend', confidence: 0.8, probabilities: { ui: 0.2, backend: 0.8 } } },
  });
  const capture = captureEvents();
  const jev = createFakeJev({ seed, emit: capture.emit });
  const answered = await jev.ask(THREE_QUESTIONS);
  expect(answered.model).toBe('jev-seeded');
  expect(answered.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
  expect(answered.answers.area).toEqual({
    type: 'choice',
    choice: 'backend',
    confidence: 0.8,
    probabilities: { ui: 0.2, backend: 0.8 },
  });
  expect(answered.answers.clear).toEqual({ type: 'noul', noul: 1 });
  expect(capture.events).toEqual([
    {
      type: 'jev:asked',
      model: 'jev-seeded',
      questions: 3,
      latencyMs: answered.latencyMs,
      usage: { inputTokens: 12, outputTokens: 3 },
    },
  ]);
});

test('the request names the model, over the seed and the option', async () => {
  const jev = createFakeJev({ seed: seedFile({ model: 'jev-seeded' }), model: 'jev-option' });
  expect((await jev.ask({ ...THREE_QUESTIONS, model: 'jev-request' })).model).toBe('jev-request');
  expect((await jev.ask(THREE_QUESTIONS)).model).toBe('jev-seeded');
  expect((await createFakeJev({ seed: seedFile(), model: 'jev-option' }).ask(THREE_QUESTIONS)).model).toBe(
    'jev-option',
  );
});

test('a seeded 429 fails unavailable with the status and the detail in the message, and emits nothing', async () => {
  const capture = captureEvents();
  const jev = createFakeJev({
    seed: seedFile({ error: { status: 429, detail: 'rate limited' } }),
    emit: capture.emit,
  });
  const error = await rejection(jev.ask(THREE_QUESTIONS));
  expect(error).toBeInstanceOf(PortError);
  const { port, op, code, message } = error as PortError;
  expect({ port, op, code }).toEqual({ port: 'jev', op: 'ask', code: 'unavailable' });
  expect(message).toBe('jev.ask: TypeSafe answered 429 Too Many Requests: rate limited');
  expect(capture.events).toEqual([]);
});

test('a seeded 422 fails invalid', async () => {
  const jev = createFakeJev({ seed: seedFile({ error: { status: 422, detail: 'questions: required' } }) });
  const error = (await rejection(jev.ask(THREE_QUESTIONS))) as PortError;
  expect({ code: error.code, message: error.message }).toEqual({
    code: 'invalid',
    message: 'jev.ask: TypeSafe answered 422 Unprocessable Entity: questions: required',
  });
});

test('a seeded answer of another type than the question fails invalid, naming the question', async () => {
  const jev = createFakeJev({ seed: seedFile({ answers: { area: { type: 'noul', noul: 1 } } }) });
  const error = (await rejection(jev.ask(THREE_QUESTIONS))) as PortError;
  expect({ code: error.code, message: error.message }).toEqual({
    code: 'invalid',
    message: "jev.ask: the seed answers 'area' with a noul, but the question is a choice",
  });
});

test('a seeded choice that is no option of the question fails invalid', async () => {
  const jev = createFakeJev({ seed: seedFile({ answers: { area: { type: 'choice', choice: 'database' } } }) });
  const error = (await rejection(jev.ask(THREE_QUESTIONS))) as PortError;
  expect({ code: error.code, message: error.message }).toEqual({
    code: 'invalid',
    message: "jev.ask: the seed answers 'area' with 'database', which is no option of the question",
  });
});

test('a seed that is no JSON, or breaks its shape, fails invalid', async () => {
  for (const seed of ['{ nope', { answers: 3 }]) {
    const error = (await rejection(createFakeJev({ seed: seedFile(seed) }).ask(THREE_QUESTIONS))) as PortError;
    expect({ port: error.port, code: error.code }).toEqual({ port: 'jev', code: 'invalid' });
    expect(error.message).toMatch(/^jev\.ask: the seed .*jev\.json/);
  }
});
