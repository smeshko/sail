// The Linear GraphQL client (TASK-002): every failure maps to a PortError that keeps the provider's message and never
// carries the key or the request body, and the key goes out as the raw Authorization header.
import { expect, test } from 'bun:test';
import { createLinearClient } from '../../../../src/adapters/ticket-source/linear/client';
import { createLinearWorld, type Injected } from '../../../helpers/linear-world';
import { messageOf, portFailure, rejection } from '../../../helpers/ports';

const KEY = 'lin_api_SENTINEL-key-7f3a9c';
const MARKER = 'REQUEST-BODY-MARKER';
const DOCUMENT = `query FetchIssue($team: String!, $number: Float!, $marker: String) {
  issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }) { nodes { id identifier } }
}`;
const VARIABLES = { team: 'ADW', number: 95, marker: MARKER };

/** A client over a fresh world, with `injected` answering the next FetchIssue. */
function failing(injected: Injected) {
  const world = createLinearWorld();
  world.injectFailure(injected, 'FetchIssue');
  const client = createLinearClient({ apiKey: KEY, fetch: world.transport });
  return { world, client };
}

const request = (client: ReturnType<typeof createLinearClient>) => client.request('FetchIssue', DOCUMENT, VARIABLES);

test('a 401 is unauthorized, and keeps the provider message', async () => {
  const { client } = failing({
    status: 401,
    body: { errors: [{ message: 'Authentication required, not logged in' }] },
  });
  const error = await rejection(request(client));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'FetchIssue', code: 'unauthorized' });
  expect(messageOf(error)).toContain('Authentication required, not logged in');
});

test('a 403 is forbidden, and keeps the provider message', async () => {
  const { client } = failing({ status: 403, body: { errors: [{ message: 'Forbidden for team ADW' }] } });
  const error = await rejection(request(client));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'FetchIssue', code: 'forbidden' });
  expect(messageOf(error)).toContain('Forbidden for team ADW');
});

test('a 429 is unavailable, with a rate-limit message', async () => {
  const { client } = failing({ status: 429, body: { errors: [{ message: 'Rate limit exceeded' }] } });
  const error = await rejection(request(client));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'FetchIssue', code: 'unavailable' });
  expect(messageOf(error)).toMatch(/rate limit/i);
});

test.each([500, 502, 503])('any other 5xx is unavailable: HTTP %i', async (status) => {
  const { client } = failing({ status, body: { errors: [{ message: 'Service is down' }] } });
  const error = await rejection(request(client));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'FetchIssue', code: 'unavailable' });
  expect(messageOf(error)).toContain('Service is down');
});

test.each([
  ['a network failure', new TypeError('fetch failed')],
  ['a timeout', new DOMException('The operation timed out.', 'TimeoutError')],
])('%s is unavailable', async (_, reason) => {
  const { client } = failing({ reject: reason });
  const error = await rejection(request(client));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'FetchIssue', code: 'unavailable' });
});

test.each([
  ['AUTHENTICATION_ERROR', 'unauthorized'],
  ['FORBIDDEN', 'forbidden'],
  ['RATELIMITED', 'unavailable'],
  ['SOMETHING_NEW', 'invalid'],
])('a GraphQL error coded %s is %s, and keeps its message', async (code, expected) => {
  const { client } = failing({ errors: [{ message: `Linear says ${code}`, code }] });
  const error = await rejection(request(client));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'FetchIssue', code: expected });
  expect(messageOf(error)).toContain(`Linear says ${code}`);
});

test('an HTTP 200 with no data is invalid', async () => {
  const { client } = failing({ status: 200, body: {} });
  expect(portFailure(await rejection(request(client)))).toEqual({
    port: 'ticketSource',
    op: 'FetchIssue',
    code: 'invalid',
  });
});

test('every PortError names the port and the operation, and carries no request body', async () => {
  const { client } = failing({ errors: [{ message: 'Nope', code: 'SOMETHING_NEW' }] });
  const error = await rejection(request(client));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'FetchIssue', code: 'invalid' });
  const carried = JSON.stringify({ message: messageOf(error), raw: (error as { raw?: unknown }).raw ?? null });
  expect([carried.includes(MARKER), carried.includes('issues(filter')]).toEqual([false, false]);
});

test('the API key appears in no error message and in no error payload, whichever way the call failed', async () => {
  const answers: Injected[] = [
    { status: 401, body: { errors: [{ message: 'Authentication required' }] } },
    { status: 403 },
    { status: 429 },
    { status: 500 },
    { reject: new TypeError('fetch failed') },
    { errors: [{ message: 'Bad credentials', code: 'AUTHENTICATION_ERROR' }] },
    { status: 200, body: {} },
  ];
  const seen: string[] = [];
  const codes: string[] = [];
  for (const answer of answers) {
    const { client } = failing(answer);
    const error = await rejection(request(client));
    const code = portFailure(error);
    codes.push(typeof code === 'string' ? code : code.code);
    seen.push(messageOf(error), JSON.stringify((error as { raw?: unknown }).raw ?? null), String(error));
  }
  expect(codes).toEqual([
    'unauthorized',
    'forbidden',
    'unavailable',
    'unavailable',
    'unavailable',
    'unauthorized',
    'invalid',
  ]);
  expect(seen.filter((text) => text.includes(KEY))).toEqual([]);
});

test('the Authorization header is the key exactly, with no Bearer prefix, and the body is JSON', async () => {
  const world = createLinearWorld({ issues: [{ identifier: 'ADW-95', title: 'Ticket', state: 'Todo' }] });
  await createLinearClient({ apiKey: KEY, fetch: world.transport }).request('FetchIssue', DOCUMENT, VARIABLES);
  const [sent] = world.requests;
  expect([sent?.headers.authorization, sent?.headers['content-type']]).toEqual([KEY, 'application/json']);
  expect(sent?.url).toBe('https://api.linear.app/graphql');
});

test('a successful answer resolves with its data, and the request carries the operation and its variables', async () => {
  const world = createLinearWorld({ issues: [{ identifier: 'ADW-95', title: 'Ticket', state: 'Todo' }] });
  const data = (await createLinearClient({ apiKey: KEY, fetch: world.transport }).request('FetchIssue', DOCUMENT, {
    team: 'ADW',
    number: 95,
  })) as { issues: { nodes: { identifier: string }[] } };
  expect(data).toMatchObject({ issues: { nodes: [{ identifier: 'ADW-95' }] } });
  expect(world.requests.map((sent) => [sent.operation, sent.variables])).toEqual([
    ['FetchIssue', { team: 'ADW', number: 95 }],
  ]);
});

test('without an injected fetch, the client calls globalThis.fetch as it is at each call', async () => {
  const world = createLinearWorld({ issues: [{ identifier: 'ADW-95', title: 'Ticket', state: 'Todo' }] });
  const client = createLinearClient({ apiKey: KEY });
  const original = globalThis.fetch;
  globalThis.fetch = world.transport;
  try {
    await client.request('FetchIssue', DOCUMENT, { team: 'ADW', number: 95 });
  } finally {
    globalThis.fetch = original;
  }
  expect(world.requests.map((sent) => sent.operation)).toEqual(['FetchIssue']);
});

test('a request that outlives its timeout is unavailable, and the request carries an abort signal', async () => {
  let signalled = false;
  const hangs = ((_input: string, init?: RequestInit) =>
    new Promise((_, reject) => {
      signalled = init?.signal instanceof AbortSignal;
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
  const client = createLinearClient({ apiKey: KEY, fetch: hangs, timeoutMs: 5 });
  const error = await rejection(request(client));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'FetchIssue', code: 'unavailable' });
  expect(signalled).toBe(true);
});

// Review fixes (review #1.2, #1.5, #1.6, #1.7): the GraphQL code wins over a generic 400, an echoed key stays out of the
// error's raw body, provider text is free of terminal control characters, and a body read that fails is unavailable.
test('a 400 carrying the rate-limit code is unavailable, with the rate-limit message', async () => {
  const { client } = failing({
    status: 400,
    body: { data: null, errors: [{ message: 'Too many requests', extensions: { code: 'RATELIMITED' } }] },
  });
  const error = await rejection(request(client));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'FetchIssue', code: 'unavailable' });
  expect(messageOf(error)).toMatch(/rate limit/i);
});

test('a 400 carrying the authentication code is unauthorized', async () => {
  const { client } = failing({
    status: 400,
    body: { data: null, errors: [{ message: 'Bad key', extensions: { code: 'AUTHENTICATION_ERROR' } }] },
  });
  expect(portFailure(await rejection(request(client)))).toEqual({
    port: 'ticketSource',
    op: 'FetchIssue',
    code: 'unauthorized',
  });
});

test('an echoed key is redacted from the message, and absent from the error raw body', async () => {
  const { client } = failing({ status: 401, body: { errors: [{ message: `Bad key ${KEY}` }], echo: KEY } });
  const error = await rejection(request(client));
  expect(messageOf(error)).not.toContain(KEY);
  expect(JSON.stringify((error as { raw?: unknown }).raw ?? null)).not.toContain(KEY);
});

test('provider text reaches the PortError without terminal control characters', async () => {
  const { client } = failing({ status: 401, body: { errors: [{ message: 'bad\x1b[2K\rlogin\x1b]0;t\x07 now' }] } });
  const message = messageOf(await rejection(request(client)));
  expect([message.includes('\x1b'), message.includes('\r')]).toEqual([false, false]);
  expect(message).toContain('login');
});

test.each([
  ['a body read that times out', new DOMException('The operation timed out.', 'TimeoutError'), 'unavailable'],
  ['a body that is not JSON', new SyntaxError('Unexpected token'), 'invalid'],
])('%s maps to the expected PortError code', async (_, reason, code) => {
  const response = { status: 200, json: () => Promise.reject(reason) } as unknown as Response;
  const client = createLinearClient({ apiKey: KEY, fetch: (async () => response) as unknown as typeof fetch });
  expect(portFailure(await rejection(request(client)))).toEqual({ port: 'ticketSource', op: 'FetchIssue', code });
});

// Review fix (round 2, Codex's partial output): a GraphQL code refines a 400, but an HTTP 401, 403, 429 or 5xx keeps its
// own class whatever code the body carries.
test.each([
  [401, 'FORBIDDEN', 'unauthorized'],
  [503, 'AUTHENTICATION_ERROR', 'unavailable'],
])('HTTP %i with the code %s is %s, the status deciding', async (status, code, expected) => {
  const { client } = failing({ status, body: { data: null, errors: [{ message: 'x', extensions: { code } }] } });
  expect(portFailure(await rejection(request(client)))).toEqual({
    port: 'ticketSource',
    op: 'FetchIssue',
    code: expected,
  });
});

// Review fixes (review #2.3 to #2.6): redaction after cleaning, only codes the client knows, the rate-limit prefix only
// for a rate limit, and any recognised code in `errors`.
test('a key split by an escape sequence is still redacted', async () => {
  const split = `${KEY.slice(0, 9)}\x1b[0m${KEY.slice(9)}`;
  const { client } = failing({ status: 401, body: { errors: [{ message: `Bad key ${split}` }] } });
  expect(messageOf(await rejection(request(client)))).not.toContain(KEY);
});

test.each([
  ['a code that names a property of Object', 'constructor'],
  ['a code of the prototype chain', '__proto__'],
])('%s is not a recognised code, so a 400 with it is invalid', async (_, code) => {
  const { client } = failing({ status: 400, body: { errors: [{ message: 'x', extensions: { code } }] } });
  expect(portFailure(await rejection(request(client)))).toEqual({
    port: 'ticketSource',
    op: 'FetchIssue',
    code: 'invalid',
  });
});

test('a 401 with a rate-limit code is unauthorized, without the rate-limit prefix', async () => {
  const { client } = failing({
    status: 401,
    body: { errors: [{ message: 'nope', extensions: { code: 'RATELIMITED' } }] },
  });
  const error = await rejection(request(client));
  expect(portFailure(error)).toMatchObject({ code: 'unauthorized' });
  expect(messageOf(error)).not.toMatch(/rate limit/i);
});

// Review fix (review #3.1): a key that itself carries a control character is still redacted where the transport echoes it.
test('a key with a newline is redacted from the message', async () => {
  const multiline = 'lin_api_SENT\nINEL-key';
  const transport = (async () => {
    throw new TypeError(`Header 'Authorization' has invalid value: '${multiline}'`);
  }) as unknown as typeof fetch;
  const client = createLinearClient({ apiKey: multiline, fetch: transport });
  expect(messageOf(await rejection(request(client)))).not.toContain('lin_api_SENT');
});

test('a 400 whose second error carries a rate-limit code is unavailable', async () => {
  const { client } = failing({
    status: 400,
    body: { errors: [{ message: 'a' }, { message: 'b', extensions: { code: 'RATELIMITED' } }] },
  });
  expect(portFailure(await rejection(request(client)))).toMatchObject({ code: 'unavailable' });
});
