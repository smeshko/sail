// The Linear GraphQL client: one POST per document, the API key as the raw Authorization header, and every failure mapped
// to a PortError that keeps the provider's message and never carries the key or the request body.
import { PortError, type PortErrorCode } from '../../../ports/errors';

const ENDPOINT = 'https://api.linear.app/graphql';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Linear's `extensions.code` values that map to a code other than `invalid`. Any other code is `invalid`. */
const GRAPHQL_CODES: Readonly<Record<string, PortErrorCode>> = {
  AUTHENTICATION_ERROR: 'unauthorized',
  FORBIDDEN: 'forbidden',
  RATELIMITED: 'unavailable',
};

export interface LinearClientOptions {
  readonly apiKey: string;
  /** The transport. Left out, the client reads `globalThis.fetch` at each call. */
  readonly fetch?: typeof fetch;
  /** How long one request may take before it fails as unavailable. Left out: 30 seconds. */
  readonly timeoutMs?: number;
}

export interface LinearClient {
  /**
   * Posts `document` as the operation `operation` with `variables`, and resolves with the response's `data`. Rejects
   * with a PortError of port `ticketSource` and that operation name.
   */
  request(operation: string, document: string, variables: Record<string, unknown>): Promise<unknown>;
}

/** The messages of a GraphQL `errors` array, joined, or undefined when the body has none. */
function providerMessage(body: unknown): string | undefined {
  const errors = (body as { errors?: unknown } | undefined)?.errors;
  if (!Array.isArray(errors)) return undefined;
  const messages = errors
    .map((error) => (error as { message?: unknown } | null)?.message)
    .filter((message): message is string => typeof message === 'string');
  return messages.length === 0 ? undefined : messages.join('; ');
}

/** The first GraphQL error's `extensions.code`, when the body carries one. */
function graphqlCode(body: unknown): string | undefined {
  const first = (body as { errors?: unknown[] } | undefined)?.errors?.[0] as
    | { extensions?: { code?: unknown } }
    | undefined;
  const code = first?.extensions?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The PortError code for an HTTP status that is not a success, or undefined for a success. */
function statusCode(status: number): PortErrorCode | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429 || status >= 500) return 'unavailable';
  return 'invalid';
}

export function createLinearClient(options: LinearClientOptions): LinearClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    request: async (operation, document, variables) => {
      // Read at each call, so a test (or a caller) may replace globalThis.fetch after the client was made.
      const send = options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
      // Every failure goes through here, and nothing it is given may carry the key.
      const fail = (code: PortErrorCode, message: string, raw?: unknown): PortError => {
        const safe = options.apiKey === '' ? message : message.split(options.apiKey).join('[redacted]');
        return new PortError('ticketSource', operation, code, safe, raw);
      };

      let response: Response;
      try {
        response = await send(ENDPOINT, {
          method: 'POST',
          headers: { authorization: options.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({ operationName: operation, query: document, variables }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (reason) {
        const text = reason instanceof Error ? reason.message : 'the request failed';
        throw fail('unavailable', `Linear did not answer: ${text}`);
      }

      const body: unknown = await response.json().catch(() => undefined);
      const detail = providerMessage(body) ?? `HTTP ${response.status}`;

      const code = statusCode(response.status);
      if (code !== undefined) {
        const prefix = response.status === 429 ? 'Linear rate limit reached: ' : '';
        throw fail(code, `${prefix}${detail}`, body);
      }

      if (providerMessage(body) !== undefined) {
        const coded = graphqlCode(body);
        const mapped = coded === undefined ? 'invalid' : (GRAPHQL_CODES[coded] ?? 'invalid');
        throw fail(mapped, detail, body);
      }

      const data = (body as { data?: unknown } | undefined)?.data;
      if (data === undefined || data === null) throw fail('invalid', 'Linear answered with no data', body);
      return data;
    },
  };
}
