// The GitHub REST client against an injected `fetch`: what one request sends, and how each failure GitHub or the network
// can give becomes a PortError of the CodeHost operation, with GitHub's own message and the token masked (DECISIONS D6,
// D11). No server runs here.
import { expect, test } from 'bun:test';
import { createGitHubClient, type Fetch } from '../../../src/adapters/code-host/github-client';
import { PortError } from '../../../src/ports/errors';
import { rejection } from '../../helpers/ports';

const TOKEN = 'ghp_MARKER_client_5b0e2a91';
const API = 'http://127.0.0.1:9/api';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A client whose `fetch` records what it was sent and answers `answer()`. */
function client(answer: (init: RequestInit) => Response | Promise<Response>, timeoutMs?: number) {
  const sent: Sent[] = [];
  const fetch: Fetch = async (url, init) => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return answer(init);
  };
  const github = createGitHubClient({
    apiUrl: API,
    token: TOKEN,
    owner: 'o',
    repo: 'r',
    fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { github, sent };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A rejection's code and message, or what it was when it was no PortError. */
const failure = (error: unknown) =>
  error instanceof PortError ? { code: error.code, message: error.message } : { other: String(error) };

test('a 201 answers the parsed body, and the request carries the method, the four headers, the JSON body and the encoded path', async () => {
  const { github, sent } = client(() => json(201, { number: 7, html_url: 'https://github.com/o/r/pull/7' }));
  const path = github.repoPath('git', 'refs', 'heads', 'sail/FAKE-1#x');
  const answer = await github.request('openPullRequest', 'POST', path, { title: 'T' });
  expect(answer).toEqual({ number: 7, html_url: 'https://github.com/o/r/pull/7' });
  expect(sent).toEqual([
    {
      url: `${API}/repos/o/r/git/refs/heads/sail%2FFAKE-1%23x`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'sail',
        'content-type': 'application/json',
      },
      body: { title: 'T' },
    },
  ]);
});

test('an empty 2xx answer, such as the 201 of a rerun, is undefined, not an error', async () => {
  const { github } = client(() => new Response(null, { status: 201 }));
  expect(await github.request('rerunChecks', 'POST', github.repoPath('actions', 'runs', 9, 'rerun-failed-jobs'))).toBe(
    undefined,
  );
});

test('requestText sends a GET with the four headers and reads the answer as text, however it looks', async () => {
  const log = '2026-10-28T10:00:00Z ##[error]{"not":"json"}\n';
  const { github, sent } = client(() => new Response(log, { status: 200, headers: { 'Content-Type': 'text/plain' } }));
  const answer = await github.requestText('checkLog', github.repoPath('actions', 'jobs', 5, 'logs'));
  expect({ answer, method: sent[0]?.method, url: sent[0]?.url, authorization: sent[0]?.headers.authorization }).toEqual(
    {
      answer: log,
      method: 'GET',
      url: `${API}/repos/o/r/actions/jobs/5/logs`,
      authorization: `Bearer ${TOKEN}`,
    },
  );
});

test('requestText maps a 404 to not_found with GitHub’s message, and masks the token in a log', async () => {
  const missing = client(() => json(404, { message: 'Not Found' }));
  const error = await rejection(
    missing.github.requestText('checkLog', missing.github.repoPath('actions', 'jobs', 5, 'logs')),
  );
  const echoing = client(() => new Response(`token ${TOKEN} leaked`, { status: 200 }));
  const masked = await echoing.github.requestText('checkLog', echoing.github.repoPath('actions', 'jobs', 5, 'logs'));
  expect<unknown>({ failure: failure(error), leaked: masked.includes(TOKEN) }).toEqual({
    failure: { code: 'not_found', message: 'codeHost.checkLog: GitHub 404: Not Found' },
    leaked: false,
  });
});

const RESET = 1_790_000_000;

test.each<[string, () => Response, string, string]>([
  ['401', () => json(401, { message: 'Bad credentials' }), 'unauthorized', 'GitHub 401: Bad credentials'],
  [
    '403 with no requests left',
    () =>
      json(
        403,
        { message: 'API rate limit exceeded' },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET) },
      ),
    'unavailable',
    `GitHub 403: API rate limit exceeded; the rate limit resets at ${new Date(RESET * 1000).toISOString()}`,
  ],
  [
    'a plain 403',
    () => json(403, { message: 'Resource not accessible by integration' }),
    'forbidden',
    'GitHub 403: Resource not accessible by integration',
  ],
  ['404', () => json(404, { message: 'Not Found' }), 'not_found', 'GitHub 404: Not Found'],
  [
    '422 with errors',
    () =>
      json(422, {
        message: 'Validation Failed',
        errors: [
          { resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for o:sail/x.' },
          { resource: 'PullRequest', field: 'head', code: 'invalid' },
        ],
      }),
    'invalid',
    'GitHub 422: Validation Failed; A pull request already exists for o:sail/x.; head invalid',
  ],
  ['429', () => json(429, { message: 'Too many requests' }), 'unavailable', 'GitHub 429: Too many requests'],
  ['502', () => json(502, { message: 'Server Error' }), 'unavailable', 'GitHub 502: Server Error'],
  [
    'a body that is no JSON',
    () => new Response('<html>bad gateway</html>', { status: 502 }),
    'unavailable',
    'GitHub 502: <html>bad gateway</html>',
  ],
])("%s is a PortError %s, with GitHub's message", async (_, answer, code, message) => {
  const { github } = client(answer);
  const error = await rejection(github.request('getPullRequest', 'GET', github.repoPath('pulls', 1)));
  expect<unknown>(failure(error)).toEqual({ code, message: `codeHost.getPullRequest: ${message}` });
});

/** A response whose body breaks off after its status. */
function brokenBody(): Response {
  const body = new ReadableStream({
    pull(controller) {
      controller.error(new Error('connection reset'));
    },
  });
  return new Response(body, { status: 200 });
}

test('a fetch that throws, a body that breaks off and a timeout are unavailable, each saying which', async () => {
  const thrown = client(() => Promise.reject(new TypeError('fetch failed')));
  const broken = client(brokenBody);
  // Like fetch, it rejects with the signal's reason once the signal aborts.
  const slow = client(
    (init) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    50,
  );
  const errors = await Promise.all(
    [thrown, broken, slow].map(({ github }) => rejection(github.request('push', 'GET', github.repoPath()))),
  );
  expect(errors.map(failure)).toEqual([
    { code: 'unavailable', message: 'codeHost.push: GitHub is unreachable at 127.0.0.1:9: fetch failed' },
    {
      code: 'unavailable',
      message: 'codeHost.push: the answer from GitHub at 127.0.0.1:9 broke off: connection reset',
    },
    { code: 'unavailable', message: 'codeHost.push: GitHub at 127.0.0.1:9 did not answer within 50 ms' },
  ]);
});

test('an answer that echoes the token comes back with it masked, in the message and in raw', async () => {
  const echoed = {
    message: `Bad credentials for ${TOKEN}`,
    errors: [{ message: `token ${TOKEN} was revoked` }],
    request: { headers: { authorization: `Bearer ${TOKEN}` } },
  };
  const { github } = client(() => json(401, echoed));
  const error = await rejection(github.request('openPullRequest', 'POST', github.repoPath('pulls'), {}));
  expect(error instanceof PortError ? [error.code, error.message, error.raw] : error).toEqual([
    'unauthorized',
    'codeHost.openPullRequest: GitHub 401: Bad credentials for [redacted]; token [redacted] was revoked',
    {
      message: 'Bad credentials for [redacted]',
      errors: [{ message: 'token [redacted] was revoked' }],
      request: { headers: { authorization: 'Bearer [redacted]' } },
    },
  ]);
  expect(JSON.stringify([String(error), (error as PortError).raw])).not.toContain('MARKER');
});

test('a text answer that holds the token across the cut at 200 characters leaves no part of it (review R1-5)', async () => {
  const cut = (form: string) => `${'x'.repeat(200 - form.length + 1)}${form}`;
  const answers = [cut(TOKEN), cut(encodeURIComponent(TOKEN)), cut(Buffer.from(TOKEN).toString('base64'))];
  const messages = [];
  for (const text of answers) {
    const { github } = client(() => new Response(text, { status: 502 }));
    const error = await rejection(github.request('getPullRequest', 'GET', github.repoPath('pulls', 1)));
    messages.push(failure(error).message ?? '');
  }
  // The token's first 12 characters, `ghp_MARKER_c`, are long enough to be a fragment of it and of nothing else.
  expect(messages.map((message) => message.includes(TOKEN.slice(0, 12)))).toEqual([false, false, false]);
  expect(messages.map((message) => message.endsWith('[redacted]'))).toEqual([true, true, true]);
});
