// One GitHub REST request over plain `fetch` (DECISIONS D6). Every failure becomes a PortError of the CodeHost operation
// that keeps GitHub's own message: an HTTP status, a network failure, a body that breaks off or a timeout. The token
// goes in the request header alone, and every message and `raw` is redacted before it is thrown (D11), so an answer
// that echoes the token can't carry it on.
//
// A stub until TASK-002: it sends nothing and answers an empty object.

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

export function createGitHubClient(_options: GitHubClientOptions): GitHubClient {
  return {
    request: async <T>() => ({}) as T,
    repoPath: () => '',
  };
}
