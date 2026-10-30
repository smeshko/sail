// The typesafe Jev: the port suite on a scripted System One, then what only typesafe does: the request it sends, the
// statuses it fails with, the answers it refuses, the key it keeps out of every message, and the credential preflight.
// Nothing here reaches TypeSafe itself: test/adapters/jev/live.test.ts does, on demand.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTINS } from '../../../src/adapters/index';
import {
  createTypesafeJev,
  type Fetch,
  TYPESAFE_API_URL,
  typesafeEndpoint,
  typesafeJev,
} from '../../../src/adapters/jev/typesafe';
import { resolveAdapters } from '../../../src/engine/adapters';
import { PortError } from '../../../src/ports/errors';
import type { Jev } from '../../../src/ports/jev';
import type { JevRequest } from '../../../src/ports/types';
import { captureEvents, rejection } from '../../helpers/ports';
import { jevSuite, THREE_QUESTIONS } from '../../ports/jev.suite';

const KEY = 'ts_live_MARKER_key_4f81c2';

/** An answer shaped as the System One docs show it, for the three questions of THREE_QUESTIONS. */
const DOCS_ANSWER = {
  model: 'jev-latest',
  answers: {
    area: { type: 'choice', choice: 'ui', confidence: 0.92, probabilities: { ui: 0.92, backend: 0.08 } },
    size: {
      type: 'score',
      score: 1,
      confidence: 0.61,
      legend: 'medium',
      probabilities: { small: 0.2, medium: 0.61, large: 0.19 },
    },
    clear: { type: 'noul', noul: 0.87 },
  },
  usage: { input_tokens: 412, output_tokens: 9 },
};

interface Sent {
  url: string;
  init: RequestInit;
}

/** A fetch that answers each call with `respond`, and keeps what it was sent. */
function scripted(respond: (sent: Sent) => Response | Promise<Response>): { fetch: Fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return respond({ url, init });
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The System One of the docs, answering whatever is asked by its type. */
function echoing(): Fetch {
  return scripted(({ init }) => {
    const { questions } = JSON.parse(String(init.body)) as { questions: Record<string, { type: string }> };
    const answers = Object.fromEntries(
      Object.entries(questions).map(([name, { type }]) => [
        name,
        type === 'choice'
          ? { type, choice: 'ui', confidence: 0.9, probabilities: { ui: 0.9, backend: 0.1 } }
          : type === 'score'
            ? { type, score: 0, confidence: 0.5, legend: 'small', probabilities: [0.5, 0.3, 0.2] }
            : { type, noul: 0.7 },
      ]),
    );
    return json({ model: 'jev-latest', answers, usage: { input_tokens: 10, output_tokens: 2 } });
  }).fetch;
}

jevSuite('typesafe', async (emit) => createTypesafeJev({ apiKey: KEY, fetch: echoing(), emit }));

const asking = (fetch: Fetch, extra: { model?: string; timeoutMs?: number; apiUrl?: string } = {}) =>
  createTypesafeJev({ apiKey: KEY, fetch, ...extra });

test('a docs-shaped answer becomes typed answers keyed by name, with confidence, probabilities, legend and usage', async () => {
  const jev = asking(scripted(() => json(DOCS_ANSWER)).fetch);
  const answered = await jev.ask(THREE_QUESTIONS);
  expect(answered.model).toBe('jev-latest');
  expect(answered.usage).toEqual({ inputTokens: 412, outputTokens: 9 });
  expect(answered.answers as unknown).toEqual(DOCS_ANSWER.answers);
});

test('an answer carries the latency from sending to parsing, and jev:asked the usage', async () => {
  let clock = 1000;
  const capture = captureEvents();
  const jev = createTypesafeJev({
    apiKey: KEY,
    fetch: scripted(() => {
      clock += 250;
      return json(DOCS_ANSWER);
    }).fetch,
    emit: capture.emit,
    now: () => new Date(clock),
  });
  const answered = await jev.ask(THREE_QUESTIONS);
  expect(answered.latencyMs).toBe(250);
  expect(capture.events).toEqual([
    {
      type: 'jev:asked',
      model: 'jev-latest',
      questions: 3,
      latencyMs: 250,
      usage: { inputTokens: 412, outputTokens: 9 },
    },
  ]);
});

test('an answer without usage leaves usage out of the result and the event', async () => {
  const capture = captureEvents();
  const { usage: _usage, ...noUsage } = DOCS_ANSWER;
  const answered = await createTypesafeJev({
    apiKey: KEY,
    fetch: scripted(() => json(noUsage)).fetch,
    emit: capture.emit,
  }).ask(THREE_QUESTIONS);
  expect('usage' in answered).toBe(false);
  expect(capture.events.map((event) => 'usage' in event)).toEqual([false]);
});

test('an answer naming an empty model is the model asked, in the result and the event (review R4)', async () => {
  const capture = captureEvents();
  const answered = await createTypesafeJev({
    apiKey: KEY,
    fetch: scripted(() => json({ ...DOCS_ANSWER, model: '' })).fetch,
    emit: capture.emit,
  }).ask({ ...THREE_QUESTIONS, model: 'jev-request' });
  expect([answered.model, capture.events.map((event) => event.type === 'jev:asked' && event.model)]).toEqual([
    'jev-request',
    ['jev-request'],
  ]);
});

test('the request is a POST to /v1/systemone with a bearer key, a JSON body, and the model jev-latest by default', async () => {
  const { fetch, sent } = scripted(() => json(DOCS_ANSWER));
  await asking(fetch).ask(THREE_QUESTIONS);
  expect(sent).toHaveLength(1);
  const [{ url, init }] = sent as [Sent];
  expect(url).toBe('https://api.typesafe.ai/v1/systemone');
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
  expect(JSON.parse(String(init.body))).toEqual({
    model: 'jev-latest',
    state: THREE_QUESTIONS.state,
    questions: THREE_QUESTIONS.questions,
  });
});

test('the model comes from the request over the option, and the option over the default; a loopback apiUrl moves the endpoint', async () => {
  const bodies = async (jev: ReturnType<typeof asking>, sent: Sent[], request: JevRequest) => {
    await jev.ask(request);
    return (JSON.parse(String(sent.at(-1)?.init.body)) as { model: string }).model;
  };
  const { fetch, sent } = scripted(() => json(DOCS_ANSWER));
  const jev = asking(fetch, { model: 'jev-option', apiUrl: 'http://localhost:9999' });
  expect(await bodies(jev, sent, THREE_QUESTIONS)).toBe('jev-option');
  expect(await bodies(jev, sent, { ...THREE_QUESTIONS, model: 'jev-request' })).toBe('jev-request');
  expect(sent[0]?.url).toBe('http://localhost:9999/v1/systemone');
});

/** What asking fails with when the API answers `status` with `body`: the PortError's code and message. */
async function failure(status: number, body: unknown) {
  const error = await rejection(asking(scripted(() => json(body, status)).fetch).ask(THREE_QUESTIONS));
  expect(error).toBeInstanceOf(PortError);
  const { port, op, code, message } = error as PortError;
  return { port, op, code, message };
}

test('a 400 with a detail fails invalid, naming the status and the detail', async () => {
  expect(await failure(400, { detail: 'state must not be empty' })).toEqual({
    port: 'jev',
    op: 'ask',
    code: 'invalid',
    message: 'jev.ask: TypeSafe answered 400 Bad Request: state must not be empty',
  });
});

test('a 422 with loc, msg and type entries fails invalid, joining the messages', async () => {
  const detail = [
    { loc: ['body', 'questions', 'area', 'criteria'], msg: 'field required', type: 'missing' },
    { loc: ['body', 'model'], msg: 'unknown model', type: 'value_error' },
  ];
  expect(await failure(422, { detail })).toEqual({
    port: 'jev',
    op: 'ask',
    code: 'invalid',
    message:
      'jev.ask: TypeSafe answered 422 Unprocessable Entity: body.questions.area.criteria: field required; body.model: unknown model',
  });
});

test('a 401 fails unauthorized, a 429 and a 503 unavailable, each with its status in the message', async () => {
  expect(await failure(401, { detail: 'bad key' })).toMatchObject({
    code: 'unauthorized',
    message: 'jev.ask: TypeSafe answered 401 Unauthorized: bad key',
  });
  expect(await failure(429, { detail: 'rate limited' })).toMatchObject({
    code: 'unavailable',
    message: 'jev.ask: TypeSafe answered 429 Too Many Requests: rate limited',
  });
  expect(await failure(503, { message: 'overloaded' })).toMatchObject({
    code: 'unavailable',
    message: expect.stringContaining('TypeSafe answered 503 Service Unavailable: '),
  });
});

test('a 403 fails forbidden, a 404 not_found and a 409 conflict, each with its status in the message', async () => {
  expect(await failure(403, { detail: 'no access to this model' })).toEqual({
    port: 'jev',
    op: 'ask',
    code: 'forbidden',
    message: 'jev.ask: TypeSafe answered 403 Forbidden: no access to this model',
  });
  expect(await failure(404, { detail: 'no such endpoint' })).toEqual({
    port: 'jev',
    op: 'ask',
    code: 'not_found',
    message: 'jev.ask: TypeSafe answered 404 Not Found: no such endpoint',
  });
  expect(await failure(409, { detail: 'request in flight' })).toEqual({
    port: 'jev',
    op: 'ask',
    code: 'conflict',
    message: 'jev.ask: TypeSafe answered 409 Conflict: request in flight',
  });
});

test('an error body that is no JSON is kept as text in the message', async () => {
  const jev = asking(scripted(() => new Response('upstream connect error', { status: 502 })).fetch);
  const error = (await rejection(jev.ask(THREE_QUESTIONS))) as PortError;
  expect({ code: error.code, message: error.message }).toEqual({
    code: 'unavailable',
    message: 'jev.ask: TypeSafe answered 502 Bad Gateway: upstream connect error',
  });
});

test('a request that does not answer within timeoutMs fails unavailable, naming the timeout', async () => {
  const jev = asking(
    scripted(
      ({ init }) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    ).fetch,
    { timeoutMs: 20 },
  );
  const error = (await rejection(jev.ask(THREE_QUESTIONS))) as PortError;
  expect({ code: error.code, message: error.message }).toEqual({
    code: 'unavailable',
    message: 'jev.ask: TypeSafe at api.typesafe.ai did not answer within 20 ms',
  });
});

test('a network failure fails unavailable, keeping the cause', async () => {
  const jev = asking(
    scripted(() => {
      throw new Error('connect ECONNREFUSED');
    }).fetch,
  );
  const error = (await rejection(jev.ask(THREE_QUESTIONS))) as PortError;
  expect({ code: error.code, message: error.message }).toEqual({
    code: 'unavailable',
    message: 'jev.ask: TypeSafe is unreachable at api.typesafe.ai: connect ECONNREFUSED',
  });
});

test('an answer whose body breaks off while read fails unavailable, keeping the cause', async () => {
  const fetch = scripted(
    () =>
      ({
        ok: true,
        status: 200,
        text: () => Promise.reject(new Error('socket hang up')),
      }) as unknown as Response,
  ).fetch;
  const error = (await rejection(asking(fetch).ask(THREE_QUESTIONS))) as PortError;
  expect({ code: error.code, message: error.message }).toEqual({
    code: 'unavailable',
    message: 'jev.ask: the answer from TypeSafe at api.typesafe.ai broke off: socket hang up',
  });
});

test('an answer that lacks a question fails invalid, naming it', async () => {
  const { clear: _clear, ...partial } = DOCS_ANSWER.answers;
  const error = (await rejection(
    asking(scripted(() => json({ ...DOCS_ANSWER, answers: partial })).fetch).ask(THREE_QUESTIONS),
  )) as PortError;
  expect({ code: error.code, message: error.message }).toEqual({
    code: 'invalid',
    message: "jev.ask: TypeSafe's answer has nothing for the question 'clear'",
  });
});

test('an answer of another type than the question fails invalid, naming it', async () => {
  const wrong = { ...DOCS_ANSWER, answers: { ...DOCS_ANSWER.answers, area: { type: 'noul', noul: 0.5 } } };
  const error = (await rejection(asking(scripted(() => json(wrong)).fetch).ask(THREE_QUESTIONS))) as PortError;
  expect({ code: error.code, message: error.message }).toEqual({
    code: 'invalid',
    message: "jev.ask: TypeSafe answered the choice question 'area' with a noul",
  });
});

test('a 200 that is no JSON object fails invalid', async () => {
  const error = (await rejection(
    asking(scripted(() => new Response('<html>', { status: 200 })).fetch).ask(THREE_QUESTIONS),
  )) as PortError;
  expect({ code: error.code, message: error.message }).toEqual({
    code: 'invalid',
    message: 'jev.ask: TypeSafe answered 200 with no JSON answer: <html>',
  });
});

test("a 200 object that breaks the answer's shape fails invalid, naming where, and keeps the body", async () => {
  const { model: _model, ...noModel } = DOCS_ANSWER;
  const error = (await rejection(asking(scripted(() => json(noModel)).fetch).ask(THREE_QUESTIONS))) as PortError;
  expect({ code: error.code, message: error.message }).toEqual({
    code: 'invalid',
    message: "jev.ask: TypeSafe's answer breaks its shape at model: Invalid input: expected string, received undefined",
  });
  expect(error.raw).toEqual(noModel);
});

test('an answer echoing the key leaves it masked in the message', async () => {
  const jev = asking(scripted(() => json({ detail: `the key ${KEY} is not valid` }, 401)).fetch);
  const error = (await rejection(jev.ask(THREE_QUESTIONS))) as PortError;
  expect(error.message).toBe('jev.ask: TypeSafe answered 401 Unauthorized: the key [redacted] is not valid');
  expect(JSON.stringify(error.raw)).not.toContain(KEY);
});

test('without TYPESAFE_API_KEY the registry refuses with an issue naming it, and no request is made', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sail-typesafe-'));
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return json(DOCS_ANSWER);
  }) as typeof fetch;
  try {
    const result = await resolveAdapters({
      sailDir: dir,
      config: {
        name: 'x',
        sail: '>=0.0.0',
        adapters: {
          ticketSource: { use: 'fake' },
          codeHost: { use: 'fake' },
          harness: { use: 'fake' },
          workspace: { use: 'fake' },
          jev: { use: 'typesafe' },
        },
        models: {},
        budgets: {},
      },
      builtins: BUILTINS,
      env: {},
      ports: ['jev'],
    });
    expect(result).toEqual({
      issues: [{ path: '/adapters/jev', message: 'needs TYPESAFE_API_KEY, which is not set' }],
    });
    expect(calls).toEqual([]);
  } finally {
    globalThis.fetch = real;
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  ['https://api.typesafe.ai', 'https://api.typesafe.ai'],
  ['https://api.typesafe.ai/', 'https://api.typesafe.ai'],
  ['http://localhost:1', 'http://localhost:1'],
  ['http://127.0.0.1:1', 'http://127.0.0.1:1'],
  ['http://127.8.9.10', 'http://127.8.9.10'],
  ['http://[::1]:8080', 'http://[::1]:8080'],
  ['https://localhost:1/base', 'https://localhost:1/base'],
  ['https://localhost:1/base/', 'https://localhost:1/base'],
])('the endpoint %s is accepted, as the base %s', (value, base) => {
  expect(typesafeEndpoint(value)).toBe(base);
});

test.each([
  'http://example.net',
  'https://example.net',
  'http://api.typesafe.ai',
  'https://api.typesafe.ai.example.net',
  'https://api.typesafe.ai/other',
  'https://api.typesafe.ai?x=1',
  'https://user:pw@api.typesafe.ai',
  'http://user:pw@localhost:1',
  'ftp://localhost',
  'not a url',
  'http://0.0.0.0',
  'http://foo.localhost',
])('the endpoint %s is refused, naming SAIL_TYPESAFE_API_URL, and createTypesafeJev refuses it too', (value) => {
  expect(() => typesafeEndpoint(value)).toThrow(/^SAIL_TYPESAFE_API_URL is .*https:\/\/api\.typesafe\.ai/);
  expect(() => createTypesafeJev({ apiKey: KEY, apiUrl: value })).toThrow(/SAIL_TYPESAFE_API_URL/);
});

test('a refused endpoint shows no userinfo in the message', () => {
  expect(() => typesafeEndpoint('https://user:pw@example.net')).toThrow(
    /^SAIL_TYPESAFE_API_URL is https:\/\/example\.net\/?:/,
  );
});

/** Where `create` sends one ask, with `fetch` stubbed, for the environment `env` over the key. */
async function endpointSentTo(env: Record<string, string>): Promise<string[]> {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return json(DOCS_ANSWER);
  }) as typeof fetch;
  try {
    const context = {
      root: '/r',
      sailDir: '/r/.sail',
      runsDir: '/r/.sail-runs',
      env: { TYPESAFE_API_KEY: KEY, ...env },
    };
    await (typesafeJev.create({}, context) as Jev).ask(THREE_QUESTIONS);
    return calls;
  } finally {
    globalThis.fetch = real;
  }
}

test('the definition sends to SAIL_TYPESAFE_API_URL when it is a loopback host', async () => {
  expect(await endpointSentTo({ SAIL_TYPESAFE_API_URL: 'http://127.0.0.1:9999' })).toEqual([
    'http://127.0.0.1:9999/v1/systemone',
  ]);
});

test.each([[undefined], ['']])(
  'the definition sends to https://api.typesafe.ai when SAIL_TYPESAFE_API_URL is unset or empty (%p)',
  async (value) => {
    expect(TYPESAFE_API_URL).toBe('https://api.typesafe.ai');
    expect(await endpointSentTo(value === undefined ? {} : { SAIL_TYPESAFE_API_URL: value })).toEqual([
      'https://api.typesafe.ai/v1/systemone',
    ]);
  },
);

test('the definition refuses SAIL_TYPESAFE_API_URL on a third-party host', () => {
  const context = {
    root: '/r',
    sailDir: '/r/.sail',
    runsDir: '/r/.sail-runs',
    env: { TYPESAFE_API_KEY: KEY, SAIL_TYPESAFE_API_URL: 'https://example.net' },
  };
  expect(() => typesafeJev.create({}, context)).toThrow(/^SAIL_TYPESAFE_API_URL is https:\/\/example\.net/);
});

test('the registry refuses SAIL_TYPESAFE_API_URL on plain http off loopback with one issue, and no request is made', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sail-typesafe-'));
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return json(DOCS_ANSWER);
  }) as typeof fetch;
  try {
    const result = await resolveAdapters({
      sailDir: dir,
      config: {
        name: 'x',
        sail: '>=0.0.0',
        adapters: {
          ticketSource: { use: 'fake' },
          codeHost: { use: 'fake' },
          harness: { use: 'fake' },
          workspace: { use: 'fake' },
          jev: { use: 'typesafe' },
        },
        models: {},
        budgets: {},
      },
      builtins: BUILTINS,
      env: { TYPESAFE_API_KEY: KEY, SAIL_TYPESAFE_API_URL: 'http://example.net' },
      ports: ['jev'],
    });
    expect(result).toHaveProperty('issues');
    const issues = (result as { issues: { path: string; message: string }[] }).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('/adapters/jev');
    expect(issues[0]?.message).toContain('SAIL_TYPESAFE_API_URL is http://example.net');
    expect(calls).toEqual([]);
  } finally {
    globalThis.fetch = real;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the definition requires the key, and creates the adapter from the environment; an unknown option is refused', () => {
  const context = { root: '/r', sailDir: '/r/.sail', runsDir: '/r/.sail-runs', env: { TYPESAFE_API_KEY: KEY } };
  expect(typesafeJev.requires?.({}, {})).toEqual(['TYPESAFE_API_KEY']);
  const jev = typesafeJev.create({ model: 'jev-x', timeoutMs: 500 }, context) as Jev;
  expect(jev.name).toBe('typesafe');
  expect(jev.capabilities().questionTypes).toEqual(['choice', 'score', 'noul']);
  expect(() => typesafeJev.create({ nope: 1 }, context)).toThrow(/^typesafe jev: option nope:/);
});

test('an apiUrl option is refused, naming the variable that replaces it', () => {
  const context = { root: '/r', sailDir: '/r/.sail', runsDir: '/r/.sail-runs', env: { TYPESAFE_API_KEY: KEY } };
  expect(() => typesafeJev.create({ apiUrl: 'http://localhost:1' }, context)).toThrow(
    /^typesafe jev: option apiUrl: .*SAIL_TYPESAFE_API_URL/,
  );
});
