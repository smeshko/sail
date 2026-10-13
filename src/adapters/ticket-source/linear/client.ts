// The Linear GraphQL client: one POST per document, the API key as the raw Authorization header, and every failure mapped
// to a PortError that keeps the provider's message and never carries the key or the request body.
import { PortError, type PortErrorCode } from '../../../ports/errors';

const ENDPOINT = 'https://api.linear.app/graphql';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Terminal escape sequences, which provider text must not carry into an error a person reads. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;

/** `text` with every occurrence of `key` replaced by [redacted]. An empty key redacts nothing. */
function scrub(text: string, key: string): string {
  return key === '' ? text : text.split(key).join('[redacted]');
}

/** `text` without escape sequences, and with every other control character as a space. */
export function clean(text: string): string {
  return text.replace(ESCAPES, '').replace(CONTROLS, ' ');
}

/** Linear's `extensions.code` values that map to a code other than `invalid`. Any other code is `invalid`. */
// A Map, so a code that names a property of Object (`constructor`) is not a recognised code.
const GRAPHQL_CODES: ReadonlyMap<string, PortErrorCode> = new Map<string, PortErrorCode>([
  ['AUTHENTICATION_ERROR', 'unauthorized'],
  ['FORBIDDEN', 'forbidden'],
  ['RATELIMITED', 'unavailable'],
]);

export interface LinearClientOptions {
  readonly apiKey: string;
  /** The transport. Left out, the client reads `globalThis.fetch` at each call. */
  readonly fetch?: typeof fetch | undefined;
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

/** The first GraphQL error whose `extensions.code` the client knows, or undefined when none does. */
function graphqlCode(body: unknown): string | undefined {
  const errors = (body as { errors?: unknown } | undefined)?.errors;
  if (!Array.isArray(errors)) return undefined;
  for (const error of errors) {
    const code = (error as { extensions?: { code?: unknown } } | null)?.extensions?.code;
    if (typeof code === 'string' && GRAPHQL_CODES.has(code)) return code;
  }
  return undefined;
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
      // Every failure goes through here. Nothing it is given may carry the key or a control character, and the answer's
      // body is never attached: it may echo the key, and no caller needs it.
      const fail = (code: PortErrorCode, message: string): PortError => {
        // Redacted as sent, then cleaned, then redacted as cleaned: a key split by an escape sequence is whole after the
        // cleaning, and a key with a control character (a newline) is found in the form the transport echoed it.
        const redacted = clean(scrub(message, options.apiKey));
        return new PortError('ticketSource', operation, code, scrub(redacted, clean(options.apiKey)));
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

      // A body that fails to read is the transport's failure, unless it is simply not JSON.
      let body: unknown;
      try {
        body = await response.json();
      } catch (reason) {
        if (!(reason instanceof SyntaxError)) {
          const text = reason instanceof Error ? reason.message : 'the body failed';
          throw fail('unavailable', `Linear did not finish its answer: ${text}`);
        }
        body = undefined;
      }
      const detail = providerMessage(body) ?? `HTTP ${response.status}`;

      // The status decides 401, 403, 429 and 5xx. A recognised GraphQL code refines any other status (Linear reports rate
      // limits and failed auth as a 400), and a 200 with errors.
      const recognised = graphqlCode(body);
      const coded = recognised === undefined ? undefined : GRAPHQL_CODES.get(recognised);
      const fromStatus = statusCode(response.status);
      const code = fromStatus === undefined || fromStatus === 'invalid' ? (coded ?? fromStatus) : fromStatus;
      if (code !== undefined) {
        const rateLimited = code === 'unavailable' && (response.status === 429 || recognised === 'RATELIMITED');
        throw fail(code, `${rateLimited ? 'Linear rate limit reached: ' : ''}${detail}`);
      }

      if (providerMessage(body) !== undefined) throw fail('invalid', detail);

      const data = (body as { data?: unknown } | undefined)?.data;
      if (data === undefined || data === null) throw fail('invalid', 'Linear answered with no data');
      return data;
    },
  };
}
