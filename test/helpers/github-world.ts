// createGitHubWorld(): a scripted GitHub for the github CodeHost's tests. One repository, `owner/repo`, whose branch
// heads are read from a bare git repository, and its pull requests, answering the REST routes the adapter calls as
// GitHub's published docs describe them (API version 2022-11-28), either as an injected `fetch` or served on
// 127.0.0.1 for the CLI. The pull requests and a pull request's comments are paged by `per_page` and `page`, as GitHub
// pages them, 30 to a page unless asked. A fork's head names another repository, or none once the fork is deleted. Any
// other route answers 404, so an unplanned call shows up. A missing or wrong bearer token
// answers 401 `Bad credentials`. Each request is recorded with whether its token matched: the token is never kept.
//
// Two opt-in seed options let a world follow a run that pushes (ADW-109): `followHeads`, so an open pull request's head
// moves with its branch, and `checksFor`, so a head the seed never listed still has check runs. A seed with neither
// answers exactly as it always has.

export interface WorldPull {
  readonly number: number;
  title: string;
  body: string;
  /** Answered as GitHub's `null`: a pull request opened with no description. */
  readonly nullBody: boolean;
  readonly head: string;
  readonly base: string;
  headSha: string;
  draft: boolean;
  state: 'open' | 'closed';
  mergedAt: string | null;
  /** The merge commit's sha once merged: sha1 of `merge #<number> <headSha>`, so a test can predict it. */
  mergeCommitSha: string | null;
  /** False when GitHub won't merge it, as for a conflict or a protected base: its merge answers 405. */
  mergeable: boolean;
  labels: string[];
  comments: { id: number; body: string; user: string; createdAt: string }[];
  /** Its author's login. */
  readonly user: string;
  /** Whether its head is another repository's, or a deleted fork's, which GitHub gives no repository. */
  readonly fork: boolean | 'deleted';
}

/** A check run on a head sha, as GitHub's check-runs endpoint lists it. */
export interface WorldCheckRun {
  readonly id?: number;
  readonly app?: { readonly id: number };
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string | null;
  readonly html_url?: string | null;
  readonly details_url?: string | null;
}

/** A commit status on a head sha, as GitHub's combined status lists it. */
export interface WorldStatus {
  readonly context: string;
  readonly state: string;
  readonly target_url?: string | null;
}

export interface WorldSeedPull {
  readonly number: number;
  readonly head: string;
  readonly base?: string;
  readonly title?: string;
  readonly body?: string | null;
  readonly draft?: boolean;
  readonly state?: 'open' | 'closed';
  readonly mergedAt?: string;
  readonly labels?: readonly string[];
  /** False when GitHub won't merge it: its merge answers 405. */
  readonly mergeable?: false;
  /** The check runs on its head sha. */
  readonly checkRuns?: readonly WorldCheckRun[];
  /** The commit statuses on its head sha. */
  readonly statuses?: readonly WorldStatus[];
  /** Its author's login: `sail-bot` unless given. */
  readonly user?: string;
  /** A head in another repository, `true`, or in a fork since deleted. Its head sha is then the seed's, or zeros. */
  readonly fork?: boolean | 'deleted';
  /** Its conversation comments, oldest first. */
  readonly comments?: readonly { readonly user: string; readonly body: string }[];
  /** Its head sha, when its head is no branch of the bare repository. */
  readonly headSha?: string;
}

/** What `checksFor` answers for one head: check runs, commit statuses, or both. */
export interface WorldChecks {
  readonly checkRuns?: readonly WorldCheckRun[];
  readonly statuses?: readonly WorldStatus[];
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
  /**
   * The labels the repository has, for `missingLabels: 'drop'`. GitHub's label names are case-insensitive: a label asked
   * for in other case is one of these, applied under the repository's name.
   */
  readonly repositoryLabels?: readonly string[];
  /**
   * Whether an open pull request's head follows its branch in the bare repository: its `headSha` is read from there on
   * every request, so a push moves it, and GitHub's merge check (409 for a head that moved) sees the new head. A pull
   * request seeded with a `headSha` or as a fork keeps the head it was given. Off unless set.
   */
  readonly followHeads?: boolean;
  /**
   * The check runs and statuses of a head sha the seed doesn't list, as a pull request stands: `pull` is the pull
   * request whose head it is, and `read` counts the check-run reads of that sha, this one included, from 1. Undefined
   * answers no checks, as for a head with none. Called for every read of such a sha, so it may change its answer by
   * `read`.
   */
  readonly checksFor?: (pull: WorldPull, headSha: string, read: number) => WorldChecks | undefined;
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

/** The merge commit GitHub makes of `number` at `headSha`, derived so that a test can predict it. */
export const worldMergeSha = (number: number, headSha: string): string =>
  new Bun.CryptoHasher('sha1').update(`merge #${number} ${headSha}`).digest('hex');

/** One page of `items`, by GitHub's `page` (from 1) and `per_page` (30 unless given, at most 100). */
function page<T>(items: readonly T[], query: URLSearchParams): T[] {
  const size = Math.min(Number(query.get('per_page') ?? 30) || 30, 100);
  const at = Math.max(Number(query.get('page') ?? 1) || 1, 1);
  return items.slice((at - 1) * size, at * size);
}

export function createGitHubWorld(seed: GitHubWorldSeed): GitHubWorld {
  const { owner, repo } = seed;
  const prefix = `/repos/${owner}/${repo}`;
  const requests: WorldRequest[] = [];
  const injected: Injected[] = [];
  const known = seed.repositoryLabels ?? [];
  /** Whether two label names are one label, as GitHub matches them: without regard to case. */
  const sameLabel = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  /** The head sha of `branch` in the bare repository, or undefined when it has no such branch. */
  const headOf = (branch: string): string | undefined => {
    const shown = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], {
      cwd: seed.bare,
      env: seed.env,
      stdin: 'ignore',
    });
    return shown.exitCode === 0 ? shown.stdout.toString().trim() : undefined;
  };

  let nextComment = 1000;
  /** When the world's comments were made: one minute apart, in the order they were made. */
  const commentedAt = () => new Date(Date.UTC(2026, 9, 1) + (nextComment - 1000) * 60_000).toISOString();
  const pullRequests: WorldPull[] = (seed.pullRequests ?? []).map((pr) => ({
    number: pr.number,
    title: pr.title ?? `Pull request ${pr.number}`,
    body: pr.body ?? '',
    nullBody: pr.body === null,
    head: pr.head,
    base: pr.base ?? seed.defaultBranch,
    headSha: pr.headSha ?? (pr.fork ? undefined : headOf(pr.head)) ?? '0'.repeat(40),
    draft: pr.draft ?? false,
    state: pr.state ?? 'open',
    mergedAt: pr.mergedAt ?? null,
    mergeCommitSha: null,
    mergeable: pr.mergeable !== false,
    labels: [...(pr.labels ?? [])],
    comments: (pr.comments ?? []).map(({ user, body }) => {
      const createdAt = commentedAt();
      return { id: nextComment++, body, user, createdAt };
    }),
    user: pr.user ?? 'sail-bot',
    fork: pr.fork ?? false,
  }));
  /** The pull requests whose head follows their branch (`followHeads`). */
  const followed = new Set<number>(
    seed.followHeads === true
      ? (seed.pullRequests ?? []).filter((pr) => pr.headSha === undefined && !pr.fork).map((pr) => pr.number)
      : [],
  );
  /** Moves each followed open pull request's head to where its branch is now. */
  const follow = () => {
    for (const pr of pullRequests) {
      if (!followed.has(pr.number) || pr.state !== 'open') continue;
      const now = headOf(pr.head);
      if (now !== undefined) pr.headSha = now;
    }
  };
  /** How many times each head sha's check runs have been read, for `checksFor`. */
  const reads = new Map<string, number>();
  /** The checks of `sha`: the seed's, else what `checksFor` answers for the pull request at that head. */
  const checksOf = (sha: string, counted: boolean): WorldChecks | undefined => {
    const listed = checksBySha.get(sha);
    if (listed !== undefined || seed.checksFor === undefined) return listed;
    const read = (reads.get(sha) ?? 0) + (counted ? 1 : 0);
    if (counted) reads.set(sha, read);
    const pull = pullRequests.find((pr) => pr.headSha === sha);
    return pull === undefined ? undefined : seed.checksFor(pull, sha, read);
  };
  /** The check runs and statuses by head sha, from the seed. */
  const checksBySha = new Map<string, { checkRuns: readonly WorldCheckRun[]; statuses: readonly WorldStatus[] }>();
  for (const [i, pr] of (seed.pullRequests ?? []).entries()) {
    const headSha = pullRequests[i]?.headSha;
    if (headSha === undefined || (pr.checkRuns === undefined && pr.statuses === undefined)) continue;
    checksBySha.set(headSha, { checkRuns: pr.checkRuns ?? [], statuses: pr.statuses ?? [] });
  }

  const url = (pr: WorldPull) => `https://github.com/${owner}/${repo}/pull/${pr.number}`;
  const node = (pr: WorldPull, baseOf: (branch: string) => string | undefined = headOf) => ({
    number: pr.number,
    html_url: url(pr),
    title: pr.title,
    body: pr.nullBody ? null : pr.body,
    state: pr.state,
    merged_at: pr.mergedAt,
    merged: pr.mergedAt !== null,
    merge_commit_sha: pr.mergeCommitSha,
    draft: pr.draft,
    head: {
      ref: pr.head,
      sha: pr.headSha,
      label: `${pr.fork === true ? 'forker' : owner}:${pr.head}`,
      repo: pr.fork === 'deleted' ? null : { full_name: pr.fork ? `forker/${repo}` : `${owner}/${repo}` },
    },
    base: { ref: pr.base, sha: baseOf(pr.base) ?? '' },
    labels: pr.labels.map((name, i) => ({ id: i + 1, name })),
    user: { login: pr.user },
  });
  /** The `page`th page of `items`, `per_page` to a page, as the query asks: 30 to a page, from page 1, unless it says. */
  const paged = <T>(items: readonly T[], query: URLSearchParams): T[] => {
    const size = Number(query.get('per_page') ?? 30);
    const page = Number(query.get('page') ?? 1);
    return items.slice((page - 1) * size, page * size);
  };
  const find = (number: number) => pullRequests.find((pr) => pr.number === number);
  const isIssue = (number: number) => (seed.issues ?? []).includes(number);
  const nextNumber = () => Math.max(0, ...pullRequests.map((pr) => pr.number), ...(seed.issues ?? [])) + 1;

  function route(method: string, path: string, query: URLSearchParams, body: unknown): WorldResponse {
    follow();
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
      // One git lookup per base branch for the page, not one per pull request: a page holds up to 100.
      const bases = new Map<string, string | undefined>();
      const baseOf = (branch: string) => {
        if (!bases.has(branch)) bases.set(branch, headOf(branch));
        return bases.get(branch);
      };
      return json(
        200,
        paged(listed, query).map((pr) => node(pr, baseOf)),
      );
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
        mergeCommitSha: null,
        mergeable: true,
        labels: [],
        comments: [],
        user: 'sail-bot',
        fork: false,
        nullBody: false,
      };
      pullRequests.push(pr);
      if (seed.followHeads === true) followed.add(pr.number);
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
      // A name the repository has in any case is that label, and one the pull request holds in any case adds nothing.
      const asked = ((body as { labels?: string[] }).labels ?? [])
        .map(
          (name) => known.find((each) => sameLabel(each, name)) ?? (seed.missingLabels === 'drop' ? undefined : name),
        )
        .filter((name) => name !== undefined);
      const held = pr?.labels ?? [];
      for (const name of asked) if (!held.some((each) => sameLabel(each, name))) held.push(name);
      return json(
        200,
        held.map((name, i) => ({ id: i + 1, name })),
      );
    }
    const comments = /^\/issues\/(\d+)\/comments$/.exec(path);
    if (method === 'GET' && comments !== null) {
      const number = Number(comments[1]);
      const pr = find(number);
      if (pr === undefined && !isIssue(number)) return notFound();
      const listed = (pr?.comments ?? []).map((comment) => ({
        id: comment.id,
        user: { login: comment.user },
        body: comment.body,
        created_at: comment.createdAt,
      }));
      return json(200, paged(listed, query));
    }
    if (method === 'POST' && comments !== null) {
      const number = Number(comments[1]);
      const pr = find(number);
      if (pr === undefined && !isIssue(number)) return notFound();
      const comment = {
        id: nextComment,
        body: String((body as { body?: string }).body),
        user: 'sail-bot',
        createdAt: commentedAt(),
      };
      nextComment++;
      pr?.comments.push(comment);
      return json(201, {
        id: comment.id,
        html_url: `https://github.com/${owner}/${repo}/pull/${number}#issuecomment-${comment.id}`,
        body: comment.body,
      });
    }
    const label = /^\/issues\/(\d+)\/labels\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && label !== null) {
      const number = Number(label[1]);
      const pr = find(number);
      const name = decodeURIComponent(String(label[2]));
      // An issue's labels aren't kept: one never has the label asked for. A held label matches in any case.
      const held = pr?.labels.find((each) => sameLabel(each, name));
      if (pr === undefined || held === undefined) {
        return json(404, { message: 'Label does not exist', documentation_url: 'https://docs.github.com/rest' });
      }
      pr.labels = pr.labels.filter((each) => each !== held);
      return json(
        200,
        pr.labels.map((each, i) => ({ id: i + 1, name: each })),
      );
    }
    const checkRuns = /^\/commits\/([^/]+)\/check-runs$/.exec(path);
    if (method === 'GET' && checkRuns !== null) {
      const runs = checksOf(String(checkRuns[1]), true)?.checkRuns ?? [];
      return json(200, { total_count: runs.length, check_runs: page(runs, query) });
    }
    const status = /^\/commits\/([^/]+)\/status$/.exec(path);
    if (method === 'GET' && status !== null) {
      const sha = String(status[1]);
      const statuses = checksOf(sha, false)?.statuses ?? [];
      const state = statuses.some((each) => each.state !== 'success')
        ? statuses.some((each) => each.state === 'failure' || each.state === 'error')
          ? 'failure'
          : 'pending'
        : statuses.length === 0
          ? 'pending'
          : 'success';
      return json(200, { state, sha, total_count: statuses.length, statuses: page(statuses, query) });
    }
    const merge = /^\/pulls\/(\d+)\/merge$/.exec(path);
    if (method === 'PUT' && merge !== null) {
      const pr = find(Number(merge[1]));
      if (pr === undefined) return notFound();
      const asked = (body ?? {}) as { merge_method?: unknown; sha?: unknown };
      if (pr.state !== 'open' || pr.mergedAt !== null || !pr.mergeable) {
        return json(405, {
          message: 'Pull Request is not mergeable',
          documentation_url: 'https://docs.github.com/rest',
        });
      }
      if (asked.sha !== undefined && asked.sha !== pr.headSha) {
        return json(409, { message: 'Head branch was modified. Review and try the merge again.' });
      }
      if (!['merge', 'squash', 'rebase'].includes(String(asked.merge_method ?? 'merge'))) {
        return json(422, {
          message: 'Validation Failed',
          errors: [{ resource: 'PullRequest', field: 'merge_method', code: 'invalid' }],
        });
      }
      pr.mergedAt = '2026-10-22T09:00:00Z';
      pr.mergeCommitSha = worldMergeSha(pr.number, pr.headSha);
      pr.state = 'closed';
      return json(200, { sha: pr.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' });
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
