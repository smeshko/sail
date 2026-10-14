// One GraphQL request to Linear over plain `fetch` (DECISIONS D1). Every failure becomes a PortError that keeps Linear's
// own message: an HTTP status, a GraphQL `errors[]`, a network failure or a timeout. The API key goes in the request
// header alone, so no message and no `raw` can carry it.
import { PortError, type PortErrorCode } from '../../ports/errors';

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

/** The part of `fetch` the client calls: a test injects its own. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface LinearClientOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly fetch?: Fetch;
  /** How long a request may take. 30 s unless given. */
  readonly timeoutMs?: number;
}

export interface LinearClient {
  /** `data` of the answer to `query`, or a PortError of the TicketSource operation `op`. */
  request<T>(op: string, operationName: string, query: string, variables: Record<string, unknown>): Promise<T>;
}

interface GraphQLError {
  message?: unknown;
  extensions?: { code?: unknown; userPresentableMessage?: unknown };
}

/** A body read as JSON, or its text when it isn't JSON. */
type Body = { json: Record<string, unknown> } | { text: string };

const errorsOf = (body: Body): GraphQLError[] =>
  'json' in body && Array.isArray(body.json.errors) ? (body.json.errors as GraphQLError[]) : [];

const codesOf = (errors: readonly GraphQLError[]): unknown[] => errors.map((error) => error.extensions?.code);

/** The mapping, in order: the first row that holds gives the code. */
const MAPPING: readonly [(status: number, codes: readonly unknown[]) => boolean, PortErrorCode][] = [
  [(status, codes) => status === 401 || codes.includes('AUTHENTICATION_ERROR'), 'unauthorized'],
  [(status, codes) => status === 403 || codes.includes('FORBIDDEN'), 'forbidden'],
  [(status, codes) => status === 429 || codes.includes('RATELIMITED'), 'unavailable'],
  [
    (_, codes) =>
      codes.some((code) => ['INPUT_ERROR', 'GRAPHQL_VALIDATION_FAILED', 'BAD_USER_INPUT'].includes(String(code))),
    'invalid',
  ],
];

const codeFor = (status: number, errors: readonly GraphQLError[]): PortErrorCode =>
  MAPPING.find(([holds]) => holds(status, codesOf(errors)))?.[1] ?? 'unavailable';

/** Linear's own words: each error's message, with its `userPresentableMessage` when that says something else. */
export function linearMessage(status: number, body: Body): string {
  const errors = errorsOf(body);
  const words =
    errors.length > 0
      ? errors
          .map((error) => {
            const message = String(error.message ?? '');
            const presentable = error.extensions?.userPresentableMessage;
            return typeof presentable === 'string' && presentable !== message ? `${message} (${presentable})` : message;
          })
          .join('; ')
      : 'text' in body
        ? body.text.slice(0, 200)
        : 'an answer without data';
  return `Linear ${status}: ${words}`;
}

const resetOf = (response: Response): string => {
  const reset = Number(response.headers.get('X-RateLimit-Requests-Reset') ?? Number.NaN);
  return Number.isFinite(reset) ? `; the rate limit resets at ${new Date(reset).toISOString()}` : '';
};

export function createLinearClient(options: LinearClientOptions): LinearClient {
  const host = new URL(options.endpoint).host;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async request<T>(op: string, operationName: string, query: string, variables: Record<string, unknown>) {
      const send = options.fetch ?? fetch;
      let response: Response;
      try {
        response = await send(options.endpoint, {
          method: 'POST',
          headers: { Authorization: options.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables, operationName }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        const message = timedOut
          ? `Linear at ${host} did not answer within ${timeoutMs} ms`
          : `Linear is unreachable at ${host}: ${error instanceof Error ? error.message : String(error)}`;
        throw new PortError('ticketSource', op, 'unavailable', message);
      }
      const text = await response.text();
      let body: Body;
      try {
        const json: unknown = JSON.parse(text);
        body = typeof json === 'object' && json !== null ? { json: json as Record<string, unknown> } : { text };
      } catch {
        body = { text };
      }
      const errors = errorsOf(body);
      if (response.ok && 'json' in body && errors.length === 0 && body.json.data != null) return body.json.data as T;
      const code = codeFor(response.status, errors);
      const reset = code === 'unavailable' ? resetOf(response) : '';
      const raw = 'json' in body ? body.json : undefined;
      throw new PortError('ticketSource', op, code, `${linearMessage(response.status, body)}${reset}`, raw);
    },
  };
}
