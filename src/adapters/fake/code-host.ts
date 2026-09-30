// The fake CodeHost: pull requests in a committed seed file, with changes kept in a separate state file (D1). Checks
// and merges can be scripted per pull request, and how many times each was read is kept in the state file, so a
// scripted sequence carries on in the next process.
// STUB (TASK-005): every method answers as if the world were empty. TASK-005 writes it over store.ts.
import type { CodeHost } from '../../ports/code-host';
import type { ProviderOptions } from '../../ports/ticket-source';
import type { PullRequest } from '../../ports/types';

export interface FakeCodeHostOptions extends ProviderOptions {
  /** The committed world. Never written. */
  readonly seed: string;
  /** Where the world's changes are kept. Read instead of `seed` once it exists. */
  readonly state: string;
  /** The environment for the git the fake runs. */
  readonly env?: Readonly<Record<string, string>>;
}

function nothing(number: number): PullRequest {
  return {
    number,
    url: '',
    title: '',
    base: '',
    head: '',
    headSha: '',
    draft: false,
    state: 'closed',
    labels: [],
    raw: null,
  };
}

export function createFakeCodeHost(_options: FakeCodeHostOptions): CodeHost {
  return {
    name: 'fake',
    parseRef: () => undefined,
    push: async (_cwd, branch) => ({ branch, headSha: '', raw: null }),
    openPullRequest: async () => nothing(0),
    listDesignated: async () => [],
    getPullRequest: async (number) => nothing(number),
    checks: async (number) => ({ number, headSha: '', checks: [], raw: null }),
    merge: async () => ({ state: 'refused', reason: 'not implemented', raw: null }),
    addLabel: async (number) => ({ number, labels: [], raw: null }),
    removeLabel: async (number) => ({ number, labels: [], raw: null }),
    comment: async () => ({ id: '', raw: null }),
    capabilities: () => ({ checks: false, labels: false, drafts: false, mergeMethods: [] }),
  };
}
