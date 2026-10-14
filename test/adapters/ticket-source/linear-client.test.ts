// The Linear GraphQL client: one POST per request, and every way Linear or the network fails as a PortError that keeps
// Linear's own words. Every answer is canned by an injected fetch, so nothing here reaches the network.
import { expect, test } from 'bun:test';
import { createLinearClient, type Fetch, LINEAR_ENDPOINT } from '../../../src/adapters/ticket-source/linear-client';
import { PortError } from '../../../src/ports/errors';
import { rejection } from '../../helpers/ports';

/** A marker key: no message and no `raw` may carry it. */
const KEY = 'lin_api_MARKER_client_7f3a91';
const QUERY = 'query SailTicket($team: String!) { issues { nodes { id } } }';
/** 2026-10-14T10:00:00.000Z, as Linear's rate-limit header gives a reset time: milliseconds since the epoch. */
const RESET = { 'X-RateLimit-Requests-Reset': '1791972000000' };
const RESET_AT = '; the rate limit resets at 2026-10-14T10:00:00.000Z';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Canned {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A fetch that answers every request with `canned`, and the requests it was sent. */
function answering(canned: Canned): { fetch: Fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: Fetch = async (url, init) => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: JSON.parse(String(init.body)),
    });
    const text = typeof canned.body === 'string' ? canned.body : JSON.stringify(canned.body);
    return new Response(text, { status: canned.status, ...(canned.headers ? { headers: canned.headers } : {}) });
  };
  return { fetch, sent };
}

const clientOf = (fetch: Fetch, timeoutMs?: number) =>
  createLinearClient({ endpoint: LINEAR_ENDPOINT, apiKey: KEY, fetch, ...(timeoutMs ? { timeoutMs } : {}) });

/** What a request answered with `canned` rejects with, for the TicketSource operation `op`. */
async function failureOf(op: string, canned: Canned): Promise<unknown> {
  return rejection(clientOf(answering(canned).fetch).request(op, 'SailTicket', QUERY, { team: 'ADW' }));
}

const failureFields = (error: unknown): Record<string, unknown> | string =>
  error instanceof PortError
    ? { port: error.port, op: error.op, code: error.code, message: error.message, raw: error.raw }
    : String(error);

const HTML = `<html><head><title>502 Bad Gateway</title></head><body>${'x'.repeat(300)}</body></html>`;

/** Each failing answer: what it is, the operation, the answer, and the PortError's code and message. */
const FAILURES: [string, string, Canned, string, string][] = [
  [
    'HTTP 401',
    'get',
    { status: 401, body: { errors: [{ message: 'Authentication required, not authenticated' }] } },
    'unauthorized',
    'ticketSource.get: Linear 401: Authentication required, not authenticated',
  ],
  [
    'a 400 with AUTHENTICATION_ERROR',
    'claim',
    {
      status: 400,
      body: {
        errors: [
          {
            message: 'Invalid API key',
            extensions: { code: 'AUTHENTICATION_ERROR', userPresentableMessage: 'Your API key is not valid.' },
          },
        ],
      },
    },
    'unauthorized',
    'ticketSource.claim: Linear 400: Invalid API key (Your API key is not valid.)',
  ],
  [
    'HTTP 403',
    'comment',
    { status: 403, body: { errors: [{ message: 'Forbidden' }] } },
    'forbidden',
    'ticketSource.comment: Linear 403: Forbidden',
  ],
  [
    'FORBIDDEN',
    'get',
    {
      status: 200,
      body: {
        errors: [
          {
            message: 'You do not have access to this team',
            extensions: { code: 'FORBIDDEN', userPresentableMessage: 'You do not have access to this team' },
          },
        ],
      },
    },
    'forbidden',
    'ticketSource.get: Linear 200: You do not have access to this team',
  ],
  [
    'HTTP 429 with the reset header',
    'listDesignated',
    { status: 429, body: { errors: [{ message: 'Too many requests' }] }, headers: RESET },
    'unavailable',
    `ticketSource.listDesignated: Linear 429: Too many requests${RESET_AT}`,
  ],
  [
    'a 400 with RATELIMITED and the reset header',
    'update',
    {
      status: 400,
      body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] },
      headers: RESET,
    },
    'unavailable',
    `ticketSource.update: Linear 400: Rate limit exceeded${RESET_AT}`,
  ],
  [
    'GRAPHQL_VALIDATION_FAILED',
    'get',
    {
      status: 400,
      body: {
        errors: [
          {
            message: 'Cannot query field "bogus" on type "Issue".',
            extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
          },
        ],
      },
    },
    'invalid',
    'ticketSource.get: Linear 400: Cannot query field "bogus" on type "Issue".',
  ],
  [
    'INPUT_ERROR',
    'update',
    {
      status: 400,
      body: {
        errors: [
          {
            message: 'Argument Validation Error',
            extensions: { code: 'INPUT_ERROR', userPresentableMessage: 'stateId must be a UUID' },
          },
        ],
      },
    },
    'invalid',
    'ticketSource.update: Linear 400: Argument Validation Error (stateId must be a UUID)',
  ],
  [
    'BAD_USER_INPUT',
    'get',
    {
      status: 200,
      body: { errors: [{ message: 'Variable "$number" got invalid value', extensions: { code: 'BAD_USER_INPUT' } }] },
    },
    'invalid',
    'ticketSource.get: Linear 200: Variable "$number" got invalid value',
  ],
  [
    'errors of a code the mapping does not know',
    'get',
    {
      status: 200,
      body: {
        errors: [{ message: 'Something went wrong', extensions: { code: 'INTERNAL_ERROR' } }, { message: 'And again' }],
      },
    },
    'unavailable',
    'ticketSource.get: Linear 200: Something went wrong; And again',
  ],
  [
    'a 200 with data and errors',
    'get',
    { status: 200, body: { data: { issues: { nodes: [] } }, errors: [{ message: 'Partial failure' }] } },
    'unavailable',
    'ticketSource.get: Linear 200: Partial failure',
  ],
  [
    'a 502 with an HTML body',
    'get',
    { status: 502, body: HTML },
    'unavailable',
    `ticketSource.get: Linear 502: ${HTML.slice(0, 200)}`,
  ],
];

test('a 200 with data resolves to the data, from one POST to the endpoint with the bare key, the query, its variables and its operation name', async () => {
  const { fetch, sent } = answering({ status: 200, body: { data: { issues: { nodes: [{ id: 'issue-1' }] } } } });
  const data = await clientOf(fetch).request('get', 'SailTicket', QUERY, { team: 'ADW', number: 1 });
  expect(data).toEqual({ issues: { nodes: [{ id: 'issue-1' }] } });
  expect(sent).toEqual([
    {
      url: 'https://api.linear.app/graphql',
      method: 'POST',
      headers: { authorization: KEY, 'content-type': 'application/json' },
      body: { query: QUERY, variables: { team: 'ADW', number: 1 }, operationName: 'SailTicket' },
    },
  ]);
});

test.each(FAILURES)(
  'an answer of %s rejects with a PortError of the operation, its code, and Linear’s own words',
  async (_, op, canned, code, message) => {
    const error = await failureOf(op, canned);
    expect(failureFields(error)).toEqual({
      port: 'ticketSource',
      op,
      code,
      message,
      raw: typeof canned.body === 'string' ? undefined : canned.body,
    });
  },
);

test('a fetch that rejects is unavailable, naming the endpoint’s host and the cause', async () => {
  const fetch: Fetch = () =>
    Promise.reject(new TypeError('Unable to connect. Is the computer able to access the url?'));
  const error = await rejection(clientOf(fetch).request('get', 'SailTicket', QUERY, {}));
  expect(failureFields(error)).toEqual({
    port: 'ticketSource',
    op: 'get',
    code: 'unavailable',
    message:
      'ticketSource.get: Linear is unreachable at api.linear.app: Unable to connect. Is the computer able to access the url?',
    raw: undefined,
  });
});

test('a request Linear never answers is aborted at the timeout, and is unavailable, naming the host and the time', async () => {
  const fetch: Fetch = (_, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  const error = await rejection(clientOf(fetch, 5).request('claim', 'SailTicket', QUERY, {}));
  expect(failureFields(error)).toEqual({
    port: 'ticketSource',
    op: 'claim',
    code: 'unavailable',
    message: 'ticketSource.claim: Linear at api.linear.app did not answer within 5 ms',
    raw: undefined,
  });
});

/** A fetch whose answer's headers arrive, and whose body sends `{"data":` and then `then` does to it. */
const bodyThat =
  (then: (controller: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal | undefined) => void): Fetch =>
  async (_, init) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'));
          then(controller, init.signal ?? undefined);
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

test('an answer whose body stalls past the timeout, or breaks off, is unavailable, naming the host, not an error of its own (review R1-2)', async () => {
  // The timeout aborts the body as fetch does: the stream errors with the signal's reason.
  const stalled = bodyThat((controller, signal) =>
    signal?.addEventListener('abort', () => controller.error(signal.reason)),
  );
  const broken = bodyThat((controller) => controller.error(new TypeError('socket closed')));
  const errors = [
    await rejection(clientOf(stalled, 5).request('get', 'SailTicket', QUERY, {})),
    await rejection(clientOf(broken).request('claim', 'SailTicket', QUERY, {})),
  ];
  expect(errors.map(failureFields)).toEqual([
    {
      port: 'ticketSource',
      op: 'get',
      code: 'unavailable',
      message: 'ticketSource.get: Linear at api.linear.app did not answer within 5 ms',
      raw: undefined,
    },
    {
      port: 'ticketSource',
      op: 'claim',
      code: 'unavailable',
      message: 'ticketSource.claim: the answer from Linear at api.linear.app broke off: socket closed',
      raw: undefined,
    },
  ]);
});

test('no failure carries the API key, in its message or its raw answer', async () => {
  const errors = await Promise.all(FAILURES.map(([, op, canned]) => failureOf(op, canned)));
  expect(errors.map((error) => error instanceof PortError)).toEqual(FAILURES.map(() => true));
  const carried = errors.filter((error) => JSON.stringify(failureFields(error)).includes(KEY));
  expect(carried).toEqual([]);
});
