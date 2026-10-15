// The GitHub CodeHost: pushes a run's HEAD to its branch and opens a labelled pull request against one repository on
// github.com. Opening again from an open pull request's head into its base returns that pull request (DECISIONS D2),
// the default branch is never pushed (D3), and the ticket key rides in the body as a hidden marker (D9). Epic 14's
// operations aren't offered yet (D5). Everything that leaves the adapter, its errors, `raw` values and events, is
// redacted of the token (D11).
//
// The definition is a stub until TASK-005: it requires nothing, and BUILTINS doesn't register it yet.
import { redactor } from '../../engine/redact';
import type { ProviderEvent } from '../../events/types';
import type { AdapterDefinition } from '../../ports/adapter';
import type { CodeHost } from '../../ports/code-host';
import { PortError } from '../../ports/errors';
import type { ProviderOptions } from '../../ports/ticket-source';
import type { Labelled, PullRequest } from '../../ports/types';
import { createGitHubClient, type Fetch } from './github-client';
import { type GitHubPull, toPullRequest, withTicketMarker } from './github-pull';
import { pushHead } from './github-push';

export const GITHUB_WEB_URL = 'https://github.com';

export interface GitHubCodeHostOptions extends ProviderOptions {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly apiUrl: string;
  /** The web host: which pull URLs `parseRef` takes, and the host the token is offered to. github.com unless given. */
  readonly webUrl?: string;
  /** The remote a push goes to. `origin` unless given. */
  readonly remote?: string;
  /** Whether a pull request opens as a draft when the request doesn't say. */
  readonly draft?: boolean;
  /** The environment for the git the adapter runs. */
  readonly env: Readonly<Record<string, string>>;
  readonly fetch?: Fetch;
  readonly pushTimeoutMs?: number;
}

const NUMBER = /^#?([1-9]\d*)$/;

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const unsupported = (op: string) => async (): Promise<never> => {
  throw new PortError('codeHost', op, 'invalid', `github doesn't support ${op} yet`);
};

export function createGitHubCodeHost(options: GitHubCodeHostOptions): CodeHost {
  const { owner, repo } = options;
  const webUrl = (options.webUrl ?? GITHUB_WEB_URL).replace(/\/+$/, '');
  const remote = options.remote ?? 'origin';
  const redact = redactor([options.token]);
  const client = createGitHubClient({
    apiUrl: options.apiUrl,
    token: options.token,
    owner,
    repo,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const emit = (event: ProviderEvent) => options.emit?.(redact.value(event));
  const pullUrl = new RegExp(`^${literal(`${webUrl}/${owner}/${repo}/pull/`)}([1-9]\\d*)(?:/|#.*)?$`);
  let defaultBranch: string | undefined;

  /** `fn`, with whatever it throws redacted. */
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return redact.value(await fn());
    } catch (error) {
      throw redact.error(error);
    }
  };
  const readDefaultBranch = async (op: string): Promise<string> => {
    defaultBranch ??= (await client.request<{ default_branch: string }>(op, 'GET', client.repoPath())).default_branch;
    return defaultBranch;
  };
  const read = async (op: string, number: number): Promise<PullRequest> =>
    toPullRequest(await client.request<GitHubPull>(op, 'GET', client.repoPath('pulls', number)));
  const lookup = async (base: string, head: string): Promise<GitHubPull | undefined> => {
    const query = new URLSearchParams({ state: 'open', head: `${owner}:${head}`, base });
    const open = await client.request<GitHubPull[]>('openPullRequest', 'GET', `${client.repoPath('pulls')}?${query}`);
    return open[0];
  };
  /**
   * Adds each of `labels` that `current` lacks, and emits one `codehost:labelled` per label GitHub's answer then lists.
   * Answers the labels after, or `current` when nothing was asked.
   */
  const addLabels = async (
    op: string,
    number: number,
    labels: readonly string[],
    current: readonly string[],
  ): Promise<{ labels: string[]; raw: { name: string }[] | null }> => {
    const missing = [...new Set(labels)].filter((label) => !current.includes(label));
    if (missing.length === 0) return { labels: [...current], raw: null };
    const answer = await client.request<{ name: string }[]>(op, 'POST', client.repoPath('issues', number, 'labels'), {
      labels: missing,
    });
    const after = answer.map((label) => label.name);
    for (const label of missing) {
      if (after.includes(label)) emit({ type: 'codehost:labelled', number, label, change: 'added' });
    }
    return { labels: after, raw: answer };
  };

  return {
    name: 'github',
    parseRef(ref) {
      const number = NUMBER.exec(ref)?.[1] ?? pullUrl.exec(ref)?.[1];
      return number === undefined ? undefined : Number(number);
    },
    push: (cwd, branch) =>
      guarded(async () => {
        if (branch === (await readDefaultBranch('push'))) {
          throw new PortError('codeHost', 'push', 'invalid', `${branch} is the default branch`);
        }
        const pushed = await pushHead({
          cwd,
          remote,
          branch,
          token: options.token,
          webUrl,
          env: options.env,
          redact,
          ...(options.pushTimeoutMs === undefined ? {} : { timeoutMs: options.pushTimeoutMs }),
        });
        emit({ type: 'codehost:pushed', branch: pushed.branch, headSha: pushed.headSha });
        return pushed;
      }),
    openPullRequest: (request) =>
      guarded(async () => {
        const body = withTicketMarker(request.body, request.ticketKey);
        const reopen = async (open: GitHubPull): Promise<PullRequest> => {
          const current = (open.labels ?? []).map((label) => label.name);
          await addLabels('openPullRequest', open.number, request.labels ?? [], current);
          return read('openPullRequest', open.number);
        };
        const open = await lookup(request.base, request.head);
        if (open !== undefined) return reopen(open);
        let created: GitHubPull;
        try {
          created = await client.request<GitHubPull>('openPullRequest', 'POST', client.repoPath('pulls'), {
            title: request.title,
            head: request.head,
            base: request.base,
            body,
            draft: request.draft ?? options.draft ?? false,
          });
        } catch (error) {
          // A create that raced another: the pull request it lost to is the one to answer.
          const raced =
            error instanceof PortError &&
            error.code === 'invalid' &&
            JSON.stringify((error.raw as { errors?: unknown } | undefined)?.errors ?? []).includes('already exists');
          const winner = raced ? await lookup(request.base, request.head) : undefined;
          if (winner === undefined) throw error;
          return reopen(winner);
        }
        const pr = toPullRequest(created);
        emit({
          type: 'codehost:pr_opened',
          number: pr.number,
          url: pr.url,
          draft: pr.draft,
          base: pr.base,
          head: pr.head,
          ...(request.ticketKey === undefined ? {} : { ticketKey: request.ticketKey }),
        });
        const { labels } = await addLabels('openPullRequest', pr.number, request.labels ?? [], pr.labels);
        return { ...pr, labels };
      }),
    listDesignated: unsupported('listDesignated'),
    getPullRequest: (number) => guarded(() => read('getPullRequest', number)),
    checks: unsupported('checks'),
    merge: unsupported('merge'),
    addLabel: (number, label) =>
      guarded(async (): Promise<Labelled> => {
        const pr = await read('addLabel', number);
        if (pr.labels.includes(label)) return { number, labels: pr.labels, raw: pr.raw };
        const added = await addLabels('addLabel', number, [label], pr.labels);
        return { number, labels: added.labels, raw: added.raw };
      }),
    removeLabel: unsupported('removeLabel'),
    comment: (number, text) =>
      guarded(async () => {
        await read('comment', number);
        const posted = await client.request<{ id: number; html_url: string }>(
          'comment',
          'POST',
          client.repoPath('issues', number, 'comments'),
          { body: text },
        );
        emit({ type: 'codehost:commented', number, body: text });
        return { id: String(posted.id), url: posted.html_url, raw: posted };
      }),
    capabilities: () => ({ checks: false, labels: true, drafts: true, mergeMethods: [] }),
  };
}

/** The owner and repository of a github.com remote URL: https, scp-like ssh or ssh. Undefined for anything else. */
export function githubRepositoryOf(_url: string): { owner: string; repo: string } | undefined {
  return undefined;
}

/**
 * `github` in `project.yaml`: `repository`, `remote` and `draft` are optional, the token comes from `SAIL_GITHUB_TOKEN`
 * or else `GITHUB_TOKEN` (D7), and the endpoint from `SAIL_GITHUB_API_URL` (D6).
 */
export const githubCodeHost: AdapterDefinition<CodeHost> = {
  requires: () => [],
  create: () => createGitHubCodeHost({ owner: '', repo: '', token: '', apiUrl: '', env: {} }),
};
