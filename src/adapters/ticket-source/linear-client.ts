// One GraphQL request to Linear over plain `fetch` (DECISIONS D1). Every failure becomes a PortError that keeps Linear's
// own message: an HTTP status, a GraphQL `errors[]`, a network failure or a timeout. The API key goes in the request
// header alone, so no message and no `raw` can carry it.
//
// TDD stub (linear-ticket-source TASK-001): the signatures are final, the body answers wrong.

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

export function createLinearClient(_options: LinearClientOptions): LinearClient {
  return {
    request: async <T>() => ({}) as T,
  };
}
