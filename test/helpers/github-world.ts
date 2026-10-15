// createGitHubWorld(): a scripted GitHub for the github CodeHost's tests. One repository, `owner/repo`, whose branch
// heads are read from a bare git repository, and its pull requests, answering the REST routes the adapter calls as
// GitHub's published docs describe them (API version 2022-11-28), either as an injected `fetch` or served on
// 127.0.0.1 for the CLI. Any other route answers 404, so an unplanned call shows up. A missing or wrong bearer token
// answers 401 `Bad credentials`. Each request is recorded with whether its token matched: the token is never kept.

export interface WorldPull {
  readonly number: number;
  title: string;
  body: string;
  readonly head: string;
  readonly base: string;
  headSha: string;
  draft: boolean;
  state: 'open' | 'closed';
  mergedAt: string | null;
  labels: string[];
  comments: { id: number; body: string }[];
}

export interface WorldSeedPull {
  readonly number: number;
  readonly head: string;
  readonly base?: string;
  readonly title?: string;
  readonly body?: string;
  readonly draft?: boolean;
  readonly state?: 'open' | 'closed';
  readonly mergedAt?: string;
  readonly labels?: readonly string[];
}

export interface GitHubWorldSeed {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;
  /** The bare repository the branches are read from: the clone's origin. */
  readonly bare: string;
  /** The environment the world's git runs in. */
  readonly env: Readonly<Record<string, string>>;
  /** The token the world accepts. */
  readonly token: string;
  readonly pullRequests?: readonly WorldSeedPull[];
  /** Numbers that are issues, not pull requests: labels and comments take them, the pulls routes don't. */
  readonly issues?: readonly number[];
  /** What adding a label the repository doesn't have does: GitHub creates it unless told to drop it. */
  readonly missingLabels?: 'create' | 'drop';
  /** The labels the repository has, for `missingLabels: 'drop'`. */
  readonly repositoryLabels?: readonly string[];
}

/** A canned answer for failure injection. */
export interface WorldResponse {
  readonly status: number;
  /** Sent as JSON, or as it is when a string. */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface WorldRequest {
  readonly method: string;
  /** The path and query, without the API's base, such as `/repos/o/r/pulls?state=open&…`. */
  readonly path: string;
  /** The JSON body, when there was one. */
  readonly body?: unknown;
  /** Whether it carried the world's token. */
  readonly tokenMatched: boolean;
}

export interface GitHubWorld {
  /** Answers one request as GitHub would: inject it as the adapter's `fetch`. */
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Serves the world on 127.0.0.1 at a free port, and gives its URL: what `SAIL_GITHUB_API_URL` is set to. */
  serve(): { url: string; stop(): void };
  /** Every request the world received, in order. */
  readonly requests: WorldRequest[];
  /** The requests as `<METHOD> <path>`. */
  routes(): string[];
  /**
   * Answers the next `times` requests of `route` with `response`: a route as `<METHOD> <path pattern>`, such as
   * `POST /pulls`, the path taken after `/repos/{owner}/{repo}` (`GET /` for the repository itself), or `*` for every
   * request.
   */
  inject(route: string, response: WorldResponse, times?: number): void;
  /** The pull requests as the world holds them now. */
  readonly pullRequests: WorldPull[];
}

/** The base the world is fetched at: any URL works for the injected `fetch`. */
export const WORLD_API = 'http://github.invalid';

interface Injected {
  readonly route: string;
  readonly response: WorldResponse;
  left: number;
}

const json = (status: number, body: unknown): WorldResponse => ({ status, body });

const notFound = () => json(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });

export function createGitHubWorld(seed: GitHubWorldSeed): GitHubWorld {
  const { owner, repo } = seed;
  const prefix = `/repos/${owner}/${repo}`;
  const requests: WorldRequest[] = [];
  const injected: Injected[] = [];
  const known = new Set(seed.repositoryLabels ?? []);

  /** The head sha of `branch` in the bare repository, or undefined when it has no such branch. */
  const headOf = (branch: string): string | undefined => {
    const shown = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], {
      cwd: seed.bare,
      env: seed.env,
      stdin: 'ignore',
    });
    return shown.exitCode === 0 ? shown.stdout.toString().trim() : undefined;
  };

  const pullRequests: WorldPull[] = (seed.pullRequests ?? []).map((pr) => ({
    number: pr.number,
    title: pr.title ?? `Pull request ${pr.number}`,
    body: pr.body ?? '',
    head: pr.head,
    base: pr.base ?? seed.defaultBranch,
    headSha: headOf(pr.head) ?? '0'.repeat(40),
    draft: pr.draft ?? false,
    state: pr.state ?? 'open',
    mergedAt: pr.mergedAt ?? null,
    labels: [...(pr.labels ?? [])],
    comments: [],
  }));
  let nextComment = 1000;

  const url = (pr: WorldPull) => `https://github.com/${owner}/${repo}/pull/${pr.number}`;
  const node = (pr: WorldPull) => ({
    number: pr.number,
    html_url: url(pr),
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged_at: pr.mergedAt,
    draft: pr.draft,
    head: { ref: pr.head, sha: pr.headSha, label: `${owner}:${pr.head}` },
    base: { ref: pr.base, sha: headOf(pr.base) ?? '' },
    labels: pr.labels.map((name, i) => ({ id: i + 1, name })),
    user: { login: 'sail-bot' },
  });
  const find = (number: number) => pullRequests.find((pr) => pr.number === number);
  const isIssue = (number: number) => (seed.issues ?? []).includes(number);
  const nextNumber = () => Math.max(0, ...pullRequests.map((pr) => pr.number), ...(seed.issues ?? [])) + 1;

  function route(method: string, path: string, query: URLSearchParams, body: unknown): WorldResponse {
    if (method === 'GET' && path === '') {
      return json(200, { full_name: `${owner}/${repo}`, default_branch: seed.defaultBranch, private: true });
    }
    if (method === 'GET' && path === '/pulls') {
      const head = query.get('head');
      const base = query.get('base');
      const state = query.get('state') ?? 'open';
      const listed = pullRequests.filter(
        (pr) =>
          (state === 'all' || pr.state === state) &&
          (head === null || `${owner}:${pr.head}` === head) &&
          (base === null || pr.base === base),
      );
      return json(200, listed.map(node));
    }
    if (method === 'POST' && path === '/pulls') {
      const asked = body as { title?: string; head?: string; base?: string; body?: string; draft?: boolean };
      const headSha = headOf(String(asked.head));
      if (headSha === undefined) {
        return json(422, {
          message: 'Validation Failed',
          errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
        });
      }
      const open = pullRequests.find((pr) => pr.state === 'open' && pr.head === asked.head && pr.base === asked.base);
      if (open !== undefined) {
        return json(422, {
          message: 'Validation Failed',
          errors: [
            {
              resource: 'PullRequest',
              code: 'custom',
              message: `A pull request already exists for ${owner}:${asked.head}.`,
            },
          ],
        });
      }
      const pr: WorldPull = {
        number: nextNumber(),
        title: String(asked.title),
        body: asked.body ?? '',
        head: String(asked.head),
        base: String(asked.base),
        headSha,
        draft: asked.draft === true,
        state: 'open',
        mergedAt: null,
        labels: [],
        comments: [],
      };
      pullRequests.push(pr);
      return json(201, node(pr));
    }
    const pull = /^\/pulls\/(\d+)$/.exec(path);
    if (method === 'GET' && pull !== null) {
      const pr = find(Number(pull[1]));
      return pr === undefined ? notFound() : json(200, node(pr));
    }
    const labels = /^\/issues\/(\d+)\/labels$/.exec(path);
    if (method === 'POST' && labels !== null) {
      const number = Number(labels[1]);
      const pr = find(number);
      if (pr === undefined && !isIssue(number)) return notFound();
      const asked = ((body as { labels?: string[] }).labels ?? []).filter(
        (name) => seed.missingLabels !== 'drop' || known.has(name),
      );
      const held = pr?.labels ?? [];
      for (const name of asked) if (!held.includes(name)) held.push(name);
      return json(
        200,
        held.map((name, i) => ({ id: i + 1, name })),
      );
    }
    const comments = /^\/issues\/(\d+)\/comments$/.exec(path);
    if (method === 'POST' && comments !== null) {
      const number = Number(comments[1]);
      const pr = find(number);
      if (pr === undefined && !isIssue(number)) return notFound();
      const comment = { id: nextComment++, body: String((body as { body?: string }).body) };
      pr?.comments.push(comment);
      return json(201, {
        id: comment.id,
        html_url: `https://github.com/${owner}/${repo}/pull/${number}#issuecomment-${comment.id}`,
        body: comment.body,
      });
    }
    return notFound();
  }

  function answer(method: string, target: string, headers: Headers, text: string): WorldResponse {
    const parsed = new URL(target, WORLD_API);
    const full = parsed.pathname.replace(/^\/api/, '');
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      return json(400, { message: 'Problems parsing JSON' });
    }
    const tokenMatched = headers.get('authorization') === `Bearer ${seed.token}`;
    requests.push({
      method,
      path: `${full}${parsed.search}`,
      ...(body === undefined ? {} : { body }),
      tokenMatched,
    });
    const path = full.startsWith(prefix) ? full.slice(prefix.length) : undefined;
    const failure = injected.find(
      (each) =>
        each.left > 0 && (each.route === '*' || each.route === `${method} ${path === undefined ? full : path || '/'}`),
    );
    if (failure !== undefined) {
      failure.left--;
      return failure.response;
    }
    if (!tokenMatched) {
      return json(401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
    }
    if (path === undefined) return notFound();
    return route(method, path, parsed.searchParams, body);
  }

  const toResponse = (response: WorldResponse): Response =>
    new Response(
      response.body === undefined
        ? null
        : typeof response.body === 'string'
          ? response.body
          : JSON.stringify(response.body),
      {
        status: response.status,
        headers: {
          ...(typeof response.body === 'string' ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
          ...response.headers,
        },
      },
    );

  return {
    async fetch(input, init) {
      const text = typeof init.body === 'string' ? init.body : '';
      return toResponse(answer(init.method ?? 'GET', input, new Headers(init.headers), text));
    },
    serve() {
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: async (request) =>
          toResponse(answer(request.method, request.url, request.headers, await request.text())),
      });
      return { url: `http://127.0.0.1:${server.port}/api`, stop: () => server.stop(true) };
    },
    requests,
    routes: () => requests.map((request) => `${request.method} ${request.path}`),
    inject(route, response, times = 1) {
      injected.push({ route, response, left: times });
    },
    pullRequests,
  };
}
