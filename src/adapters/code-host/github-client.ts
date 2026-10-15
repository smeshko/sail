// One GitHub REST request over plain `fetch` (DECISIONS D6). Every failure becomes a PortError of the CodeHost operation
// that keeps GitHub's own message: an HTTP status, a network failure, a body that breaks off or a timeout. The token
// goes in the request header alone, and every message and `raw` is redacted before it is thrown (D11), so an answer
// that echoes the token can't carry it on.
import { redactor } from '../../engine/redact';
import { PortError, type PortErrorCode } from '../../ports/errors';

export const GITHUB_API_URL = 'https://api.github.com';

/** The part of `fetch` the client calls: a test injects its own. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  readonly apiUrl: string;
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly fetch?: Fetch;
  /** How long a request may take. 30 s unless given. */
  readonly timeoutMs?: number;
}

export interface GitHubClient {
  /** The parsed JSON of the answer to `method path`, or a PortError of the CodeHost operation `op`. */
  request<T>(op: string, method: string, path: string, body?: unknown): Promise<T>;
  /** `/repos/{owner}/{repo}/…`, each segment encoded on its own. */
  repoPath(...segments: readonly (string | number)[]): string;
}

interface GitHubError {
  message?: unknown;
  field?: unknown;
  code?: unknown;
}

/** A body read as JSON, or its text when it isn't JSON. */
type Body = { json: unknown } | { text: string };

const messageOf = (body: Body): unknown =>
  'json' in body && typeof body.json === 'object' && body.json !== null
    ? (body.json as { message?: unknown }).message
    : undefined;

const errorsOf = (body: Body): GitHubError[] => {
  if (!('json' in body) || typeof body.json !== 'object' || body.json === null) return [];
  const errors = (body.json as { errors?: unknown }).errors;
  return Array.isArray(errors) ? (errors as GitHubError[]) : [];
};

const isRateLimit = (response: Response, body: Body): boolean =>
  response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(String(messageOf(body) ?? ''));

/** The mapping, in order: the first row that holds gives the code. */
const MAPPING: readonly [(response: Response, body: Body) => boolean, PortErrorCode][] = [
  [(response) => response.status === 401, 'unauthorized'],
  [(response, body) => response.status === 403 && isRateLimit(response, body), 'unavailable'],
  [(response) => response.status === 403, 'forbidden'],
  [(response) => response.status === 404, 'not_found'],
  [(response) => response.status === 409, 'conflict'],
  [(response) => response.status === 422, 'invalid'],
];

const codeFor = (response: Response, body: Body): PortErrorCode =>
  MAPPING.find(([holds]) => holds(response, body))?.[1] ?? 'unavailable';

/** GitHub's own words: its message, then each error's message, or its field and code when it has none. */
export function githubMessage(status: number, body: Body): string {
  const message = messageOf(body);
  const words =
    message === undefined
      ? 'text' in body
        ? body.text.slice(0, 200)
        : 'an answer without a message'
      : String(message);
  const errors = errorsOf(body).map((error) =>
    error.message === undefined ? `${String(error.field)} ${String(error.code)}` : String(error.message),
  );
  return [`GitHub ${status}: ${words}`, ...errors].join('; ');
}

/** When the rate limit resets, from `x-ratelimit-reset` (epoch seconds) or `retry-after` (seconds from now). */
function resetOf(response: Response): string {
  const reset = response.headers.get('x-ratelimit-reset');
  const retry = response.headers.get('retry-after');
  const at =
    reset !== null
      ? new Date(Number(reset) * 1000)
      : retry !== null
        ? new Date(Date.now() + Number(retry) * 1000)
        : new Date(Number.NaN);
  return Number.isFinite(at.getTime()) ? `; the rate limit resets at ${at.toISOString()}` : '';
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const apiUrl = options.apiUrl.replace(/\/+$/, '');
  const host = new URL(apiUrl).host;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const redact = redactor([options.token]);
  /** A failure of the transport, before the answer or while its body is read, as a PortError `unavailable`. */
  const transport = (op: string, error: unknown, failed: string): PortError => {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    const message = timedOut
      ? `GitHub at ${host} did not answer within ${timeoutMs} ms`
      : `${failed}: ${error instanceof Error ? error.message : String(error)}`;
    return new PortError('codeHost', op, 'unavailable', message);
  };
  const encode = (segment: string | number) => encodeURIComponent(String(segment));
  return {
    repoPath: (...segments) => ['', 'repos', options.owner, options.repo, ...segments].map(encode).join('/'),
    async request<T>(op: string, method: string, path: string, body?: unknown) {
      try {
        const send = options.fetch ?? fetch;
        let response: Response;
        let text: string;
        try {
          response = await send(`${apiUrl}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${options.token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'sail',
              ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          throw transport(op, error, `GitHub is unreachable at ${host}`);
        }
        try {
          // Masked whole, before anything cuts it: a token across the cut would leave a fragment no redactor knows.
          text = redact.text(await response.text());
        } catch (error) {
          throw transport(op, error, `the answer from GitHub at ${host} broke off`);
        }
        let parsed: Body;
        try {
          parsed = { json: JSON.parse(text) };
        } catch {
          parsed = { text };
        }
        if (response.ok && 'json' in parsed) return parsed.json as T;
        const code = response.ok ? 'unavailable' : codeFor(response, parsed);
        const limited = response.status === 429 || isRateLimit(response, parsed);
        const reset = code === 'unavailable' && limited ? resetOf(response) : '';
        const raw = 'json' in parsed ? parsed.json : undefined;
        throw new PortError('codeHost', op, code, `${githubMessage(response.status, parsed)}${reset}`, raw);
      } catch (error) {
        throw redact.error(error);
      }
    },
  };
}
