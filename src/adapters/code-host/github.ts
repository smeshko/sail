// The GitHub CodeHost: pushes a run's HEAD to its branch and opens a labelled pull request against one repository on
// github.com. Opening again from an open pull request's head into its base returns that pull request (DECISIONS D2),
// the default branch is never pushed (D3), and the ticket key rides in the body as a hidden marker (D9). It reads checks,
// swaps labels and merges at the head a workflow expects, recording a merge only once GitHub reports it (ADW-127's D2).
// `listDesignated` pages through the open pull requests and keeps the designated ones of this repository, and
// `getPullRequest` reads the details with the comments, paged (14.2's D11). Everything that leaves the adapter, its
// errors, `raw` values and events, is redacted of the token (D11).
import { z } from 'zod';
import { redactor } from '../../engine/redact';
import type { ProviderEvent } from '../../events/types';
import type { AdapterDefinition } from '../../ports/adapter';
import type { CodeHost } from '../../ports/code-host';
import { PortError } from '../../ports/errors';
import type { ProviderOptions } from '../../ports/ticket-source';
import { type Labelled, MergeRequest, type MergeResult, mergeRequestIssue, type PullRequest } from '../../ports/types';
import { gitSync, stripUserinfo } from '../workspace/git';
import { readChecks } from './github-checks';
import { createGitHubClient, type Fetch, GITHUB_API_URL } from './github-client';
import {
  type GitHubComment,
  type GitHubPull,
  isFork,
  toPullRequest,
  toPullRequestDetails,
  withTicketMarker,
} from './github-pull';
import { gitEnv, pushHead } from './github-push';

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

const SHA = /^[0-9a-f]{40}$/;
// A dot segment collapses the DELETE's path onto the labels collection, which GitHub reads as removing every label.
const DOTS = /^\.\.?$/;

/** A page of a list GitHub pages, and how many pages are read at most: 1000 items. */
const PAGE = 100;
const MAX_PAGES = 10;

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// GitHub's label names are case-insensitive.
const sameLabel = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const holds = (labels: readonly string[], label: string) => labels.some((each) => sameLabel(each, label));

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
  /**
   * Refuses text bound for GitHub that holds the token in any form the redactor knows: GitHub would publish it, while
   * the run's own records show it masked (review R1-10).
   */
  const unsent = (op: string, what: string, ...texts: string[]) => {
    if (texts.some((text) => redact.text(text) !== text)) {
      throw new PortError('codeHost', op, 'invalid', `${what} holds the token`);
    }
  };

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
  /** Every item of the list at `path`, page after page until one holds fewer than `PAGE`, at most `MAX_PAGES`. */
  const paged = async <T>(op: string, path: string, query: Record<string, string>): Promise<T[]> => {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const search = new URLSearchParams({ ...query, per_page: String(PAGE), page: String(page) });
      const answer = await client.request<T[]>(op, 'GET', `${path}?${search}`);
      items.push(...answer);
      if (answer.length < PAGE) return items;
    }
    throw new PortError(
      'codeHost',
      op,
      'invalid',
      `GitHub lists ${PAGE * MAX_PAGES} or more: sail reads ${MAX_PAGES} pages`,
    );
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
    const missing = labels.filter(
      (label, i) => labels.findIndex((each) => sameLabel(each, label)) === i && !holds(current, label),
    );
    if (missing.length === 0) return { labels: [...current], raw: null };
    const answer = await client.request<{ name: string }[]>(op, 'POST', client.repoPath('issues', number, 'labels'), {
      labels: missing,
    });
    const after = answer.map((label) => label.name);
    for (const asked of missing) {
      const label = after.find((name) => sameLabel(name, asked));
      if (label !== undefined) emit({ type: 'codehost:labelled', number, label, change: 'added' });
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
          repository: `${owner}/${repo}`,
          ...(options.pushTimeoutMs === undefined ? {} : { timeoutMs: options.pushTimeoutMs }),
        });
        emit({ type: 'codehost:pushed', branch: pushed.branch, headSha: pushed.headSha });
        return pushed;
      }),
    openPullRequest: (request) =>
      guarded(async () => {
        unsent('openPullRequest', "the pull request's title or body", request.title, request.body);
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
    listDesignated: (label) =>
      guarded(async () => {
        const open = await paged<GitHubPull>('listDesignated', client.repoPath('pulls'), { state: 'open' });
        // Checked again here: designation is code, never what a list query was asked for.
        return open
          .filter(
            (node) =>
              node.state === 'open' &&
              node.draft !== true &&
              (node.labels ?? []).some((each) => each.name === label) &&
              !isFork(node, `${owner}/${repo}`),
          )
          .sort((a, b) => a.number - b.number)
          .map(toPullRequest);
      }),
    getPullRequest: (number) =>
      guarded(async () => {
        const node = await client.request<GitHubPull>('getPullRequest', 'GET', client.repoPath('pulls', number));
        const path = client.repoPath('issues', number, 'comments');
        const comments = await paged<GitHubComment>('getPullRequest', path, {});
        return toPullRequestDetails(node, comments, `${owner}/${repo}`);
      }),
    checks: (number) =>
      guarded(async () => {
        const pr = await read('checks', number);
        const { checks, raw } = await readChecks(client, 'checks', pr.headSha);
        emit({
          type: 'codehost:checks',
          number,
          headSha: pr.headSha,
          checks: checks.map(({ name, status }) => ({ name, status })),
        });
        return { number, headSha: pr.headSha, checks, raw };
      }),
    merge: (number, request) =>
      guarded(async (): Promise<MergeResult> => {
        const parsed = MergeRequest.safeParse(request);
        if (!parsed.success) throw new PortError('codeHost', 'merge', 'invalid', mergeRequestIssue(request));
        const { method, expectedHeadSha } = parsed.data;
        const node = await client.request<GitHubPull>('merge', 'GET', client.repoPath('pulls', number));
        // Merged already: the merge GitHub reports, announced by the call that made it, and by no later one.
        if (node.merged_at) {
          const sha = node.merge_commit_sha ?? '';
          return SHA.test(sha)
            ? { state: 'merged', sha, raw: node }
            : { state: 'pending', reason: `GitHub reports #${number} merged without its merge commit`, raw: node };
        }
        if (node.state !== 'open') return { state: 'refused', reason: `pull request #${number} is closed`, raw: node };
        if (node.draft === true) return { state: 'refused', reason: `pull request #${number} is a draft`, raw: node };
        if (node.head.sha !== expectedHeadSha) {
          const reason = `head moved: expected ${expectedHeadSha}, pull request #${number} is at ${node.head.sha}`;
          return { state: 'refused', reason, raw: node };
        }
        // The sha too: GitHub refuses the merge, 409, if the head moved since the read above.
        const answer = await client.request<{ sha?: unknown; merged?: unknown; message?: unknown }>(
          'merge',
          'PUT',
          client.repoPath('pulls', number, 'merge'),
          { merge_method: method, sha: expectedHeadSha },
        );
        if (answer.merged === true && typeof answer.sha === 'string' && SHA.test(answer.sha)) {
          emit({ type: 'codehost:merged', number, method, sha: answer.sha });
          return { state: 'merged', sha: answer.sha, raw: answer };
        }
        const reason =
          answer.merged === true
            ? `GitHub reports #${number} merged without its merge commit`
            : typeof answer.message === 'string' && answer.message !== ''
              ? answer.message
              : 'GitHub answered without reporting the merge';
        return { state: 'pending', reason, raw: answer };
      }),
    addLabel: (number, label) =>
      guarded(async (): Promise<Labelled> => {
        const pr = await read('addLabel', number);
        if (holds(pr.labels, label)) return { number, labels: pr.labels, raw: pr.raw };
        const added = await addLabels('addLabel', number, [label], pr.labels);
        return { number, labels: added.labels, raw: added.raw };
      }),
    removeLabel: (number, label) =>
      guarded(async (): Promise<Labelled> => {
        if (DOTS.test(label)) {
          throw new PortError(
            'codeHost',
            'removeLabel',
            'invalid',
            `the label "${label}" is a path segment of dots: its DELETE would reach the pull request's labels collection`,
          );
        }
        const pr = await read('removeLabel', number);
        const held = pr.labels.find((each) => sameLabel(each, label));
        if (held === undefined) return { number, labels: pr.labels, raw: pr.raw };
        let answer: { name: string }[];
        try {
          answer = await client.request<{ name: string }[]>(
            'removeLabel',
            'DELETE',
            client.repoPath('issues', number, 'labels', held),
          );
        } catch (error) {
          // The label went in a race: the labels as they are now are the answer, and nothing changed here.
          if (!(error instanceof PortError) || error.code !== 'not_found') throw error;
          const now = await read('removeLabel', number);
          return { number, labels: now.labels, raw: now.raw };
        }
        const labels = answer.map((each) => each.name);
        if (!holds(labels, held)) emit({ type: 'codehost:labelled', number, label: held, change: 'removed' });
        return { number, labels, raw: answer };
      }),
    comment: (number, text) =>
      guarded(async () => {
        unsent('comment', 'the comment', text);
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
    capabilities: () => ({ checks: true, labels: true, drafts: true, mergeMethods: ['merge', 'squash', 'rebase'] }),
  };
}

/**
 * An owner and a repository name as GitHub allows them. A name of dots alone is refused: the API path would read it as
 * a path segment, and reach another endpoint (review R1-9).
 */
const OWNER = /^[A-Za-z0-9-]+$/;
const NAME = /^(?!\.+$)[A-Za-z0-9._-]+$/;

/** The owner and repository of a github.com remote URL: https, scp-like ssh or ssh. Undefined for anything else. */
export function githubRepositoryOf(url: string): { owner: string; repo: string } | undefined {
  const found =
    /^https:\/\/(?:[^/@]*@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url) ??
    /^ssh:\/\/git@github\.com(?::22)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  const [, owner, repo] = found ?? [];
  return owner === undefined || repo === undefined || !OWNER.test(owner) || !NAME.test(repo)
    ? undefined
    : { owner, repo };
}

const GitHubOptions = z.strictObject({
  repository: z
    .string()
    .regex(/^[A-Za-z0-9-]+\/(?!\.+$)[A-Za-z0-9._-]+$/, 'must be owner/name, such as octo/hello')
    .optional(),
  remote: z.string().min(1).optional(),
  draft: z.boolean().optional(),
});

/** The environment without its unset variables. */
const defined = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

/**
 * `github` in `project.yaml`: `repository`, `remote` and `draft` are optional, the token comes from `SAIL_GITHUB_TOKEN`
 * or else `GITHUB_TOKEN` (D7), and the endpoint from `SAIL_GITHUB_API_URL` (D6).
 */
export const githubCodeHost: AdapterDefinition<CodeHost> = {
  requires: () => [['SAIL_GITHUB_TOKEN', 'GITHUB_TOKEN']],
  create(options, context) {
    const parsed = GitHubOptions.safeParse(options);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const option = issue?.code === 'unrecognized_keys' ? issue.keys.join(', ') : issue?.path.join('.');
      throw new Error(`github codeHost: option ${option}: ${issue?.message}`);
    }
    const env = defined(context.env);
    const token = env.SAIL_GITHUB_TOKEN || env.GITHUB_TOKEN || '';
    const remote = parsed.data.remote ?? 'origin';
    let named: { owner: string; repo: string } | undefined;
    if (parsed.data.repository !== undefined) {
      const [owner = '', repo = ''] = parsed.data.repository.split('/');
      named = { owner, repo };
    } else {
      const url = gitSync(context.root, ['remote', 'get-url', remote], gitEnv(env, token));
      const shown = url.code === 0 ? stripUserinfo(url.stdout.trim()) : 'no URL';
      named = url.code === 0 ? githubRepositoryOf(url.stdout.trim()) : undefined;
      if (named === undefined) {
        throw new Error(
          `github codeHost: ${remote} is not a github.com remote (${shown}): set the repository option, such as repository: owner/name`,
        );
      }
    }
    return createGitHubCodeHost({
      ...named,
      token,
      apiUrl: env.SAIL_GITHUB_API_URL || GITHUB_API_URL,
      webUrl: GITHUB_WEB_URL,
      remote,
      ...(parsed.data.draft === undefined ? {} : { draft: parsed.data.draft }),
      env,
      ...(context.emit === undefined ? {} : { emit: context.emit }),
      ...(context.now === undefined ? {} : { now: context.now }),
    });
  },
};
