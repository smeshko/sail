// The Linear GraphQL client: one POST per document, the API key as the raw Authorization header, and every failure mapped
// to a PortError that keeps the provider's message and never carries the key or the request body.
// Stub: the transport and the error mapping are written in TASK-002.

export interface LinearClientOptions {
  readonly apiKey: string;
  /** The transport. Left out, the client reads `globalThis.fetch` at each call. */
  readonly fetch?: typeof fetch;
}

export interface LinearClient {
  /**
   * Posts `document` as the operation `operation` with `variables`, and resolves with the response's `data`. Rejects
   * with a PortError of port `ticketSource` and that operation name.
   */
  request(operation: string, document: string, variables: Record<string, unknown>): Promise<unknown>;
}

export function createLinearClient(_options: LinearClientOptions): LinearClient {
  return { request: async () => undefined };
}
