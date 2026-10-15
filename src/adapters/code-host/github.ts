// The GitHub CodeHost: pushes a run's HEAD to its branch and opens a labelled pull request against one repository on
// github.com. Opening again from an open pull request's head into its base returns that pull request (DECISIONS D2),
// the default branch is never pushed (D3), and the ticket key rides in the body as a hidden marker (D9). Epic 14's
// operations aren't offered yet (D5). Everything that leaves the adapter, its errors, `raw` values and events, is
// redacted of the token (D11).
//
// A stub until TASK-004 and TASK-005: every operation answers an empty value and asks GitHub nothing, and the
// definition requires nothing. BUILTINS doesn't register it yet.
import type { AdapterDefinition } from '../../ports/adapter';
import type { CodeHost } from '../../ports/code-host';
import type { ProviderOptions } from '../../ports/ticket-source';
import type { PullRequest } from '../../ports/types';
import type { Fetch } from './github-client';

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

const EMPTY: PullRequest = {
  number: 0,
  url: '',
  title: '',
  base: '',
  head: '',
  headSha: '',
  draft: false,
  state: 'open',
  labels: [],
  raw: {},
};

export function createGitHubCodeHost(_options: GitHubCodeHostOptions): CodeHost {
  return {
    name: 'github',
    parseRef: () => undefined,
    push: async () => ({ branch: '', headSha: '', raw: {} }),
    openPullRequest: async () => ({ ...EMPTY }),
    listDesignated: async () => [],
    getPullRequest: async () => ({ ...EMPTY }),
    checks: async () => ({ number: 0, headSha: '', checks: [], raw: {} }),
    merge: async () => ({ state: 'pending', reason: 'a stub', raw: {} }),
    addLabel: async () => ({ number: 0, labels: [], raw: {} }),
    removeLabel: async () => ({ number: 0, labels: [], raw: {} }),
    comment: async () => ({ id: '', raw: {} }),
    capabilities: () => ({ checks: true, labels: true, drafts: true, mergeMethods: ['merge', 'squash', 'rebase'] }),
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
