// The fake CodeHost: pull requests in a committed seed file, with changes kept in a separate state file (D1). Checks
// and merges can be scripted per pull request, and how many times each was read is kept in the state file, so a
// scripted sequence carries on in the next process.
import { z } from 'zod';
import type { ProviderEvent } from '../../events/types';
import type { CodeHost } from '../../ports/code-host';
import { PortError } from '../../ports/errors';
import { holdsLabel, sameLabel } from '../../ports/labels';
import type { ProviderOptions } from '../../ports/ticket-source';
import {
  CheckStatus,
  Comment,
  type Labelled,
  MergeRequest,
  type MergeResult,
  mergeRequestIssue,
  type PullRequest,
  type PullRequestDetails,
} from '../../ports/types';
import { createStore } from './store';

export interface FakeCodeHostOptions extends ProviderOptions {
  /** The committed world. Never written. */
  readonly seed: string;
  /** Where the world's changes are kept. Read instead of `seed` once it exists. */
  readonly state: string;
  /** The environment for the git the fake runs. */
  readonly env?: Readonly<Record<string, string>>;
}

const CheckScripts = z.array(z.object({ name: z.string(), statuses: z.array(CheckStatus).min(1) }));
const MergeScripts = z.array(z.enum(['merged', 'pending', 'refused', 'rejected'])).min(1);

/** A pull request as the seed holds it, with its scripts and how far each has been read. */
const StoredPullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  base: z.string(),
  head: z.string(),
  headSha: z.string(),
  draft: z.boolean(),
  state: z.enum(['open', 'closed', 'merged']),
  labels: z.array(z.string()),
  ticketKey: z.string().optional(),
  /** Each check's status on every read, the last repeating. */
  checks: CheckScripts.default([]),
  /** What each merge call is answered, the last repeating: `rejected` is the host refusing it, a PortError. */
  merges: MergeScripts.default(['merged']),
  reads: z.object({ checks: z.number().int(), merges: z.number().int() }).default({ checks: 0, merges: 0 }),
  comments: z.array(Comment).default([]),
  /** Who opened it: `sail` unless the seed says otherwise. Left out of `raw` when the seed leaves it out. */
  author: z.string().optional(),
  /** Whether its head branch lives outside the repository: false unless the seed says otherwise. */
  fork: z.boolean().optional(),
  /** The base commit the host records for it: `branches[base]` when left out. */
  baseSha: z.string().optional(),
});
type StoredPullRequest = z.infer<typeof StoredPullRequest>;

const World = z.object({
  /** Stands in for the host's URL: a pull request's is `<remote>/pull/<number>`. */
  remote: z.string(),
  defaultBranch: z.string(),
  /** Each pushed branch's head sha. */
  branches: z.record(z.string(), z.string()),
  pullRequests: z.array(StoredPullRequest),
  /** The scripts a pull request `openPullRequest` opens starts with. Left out, it has no checks and merges at once. */
  opened: z.object({ checks: CheckScripts.optional(), merges: MergeScripts.optional() }).optional(),
});
type World = z.infer<typeof World>;

const NUMBER = /^[1-9]\d*$/;

/** The script entry for the read numbered `read` from 0, the last entry repeating. Scripts are never empty. */
const scripted = <T>(entries: readonly T[], read: number): T => entries[Math.min(read, entries.length - 1)] as T;

/** The sha a merge lands on, derived so that a test can predict it and every re-read gives the same. */
const mergeSha = (pr: StoredPullRequest): string =>
  new Bun.CryptoHasher('sha1').update(`merge #${pr.number}\n${pr.headSha}`).digest('hex');

export function createFakeCodeHost(options: FakeCodeHostOptions): CodeHost {
  const store = createStore({ seed: options.seed, state: options.state, schema: World, port: 'codeHost' });
  const now = () => options.now?.() ?? new Date();
  const emit = (event: ProviderEvent) => options.emit?.(event);
  const toPullRequest = (world: World, pr: StoredPullRequest): PullRequest => ({
    number: pr.number,
    url: `${world.remote}/pull/${pr.number}`,
    title: pr.title,
    base: pr.base,
    head: pr.head,
    headSha: pr.headSha,
    draft: pr.draft,
    state: pr.state,
    labels: [...pr.labels],
    ...(pr.ticketKey === undefined ? {} : { ticketKey: pr.ticketKey }),
    raw: structuredClone(pr),
  });
  /** The details `getPullRequest` answers: the base sha the seed gives, or its base branch's head. */
  const details = (world: World, pr: StoredPullRequest): PullRequestDetails => {
    const baseSha = pr.baseSha ?? world.branches[pr.base];
    if (baseSha === undefined) {
      throw new PortError(
        'codeHost',
        'getPullRequest',
        'invalid',
        `pull request #${pr.number} has no base sha: the seed gives none, and holds no branch ${pr.base}`,
      );
    }
    return {
      ...toPullRequest(world, pr),
      body: pr.body,
      author: pr.author ?? 'sail',
      baseSha,
      fork: pr.fork ?? false,
      comments: pr.comments.map((comment) => ({ ...comment })),
    };
  };
  const find = (world: World, op: string, number: number): StoredPullRequest => {
    const found = world.pullRequests.find((pr) => pr.number === number);
    if (found === undefined) throw new PortError('codeHost', op, 'not_found', `no pull request #${number}`);
    return found;
  };
  /** Changes `name` on `pr` when it isn't so already, and says whether it changed. */
  const relabel = (pr: StoredPullRequest, change: 'added' | 'removed', name: string): boolean => {
    if (holdsLabel(pr.labels, name) === (change === 'added')) return false;
    pr.labels = change === 'added' ? [...pr.labels, name] : pr.labels.filter((each) => !sameLabel(each, name));
    return true;
  };
  const label = (op: 'addLabel' | 'removeLabel', number: number, name: string): Labelled => {
    const change = op === 'addLabel' ? 'added' : 'removed';
    const { labelled, changed } = store.change((world) => {
      const pr = find(world, op, number);
      const changed = relabel(pr, change, name);
      return { labelled: { number, labels: [...pr.labels], raw: structuredClone(pr) }, changed };
    });
    if (changed) emit({ type: 'codehost:labelled', number, label: name, change });
    return labelled;
  };

  return {
    name: 'fake',
    parseRef(ref) {
      const bare = ref.replace(/^#/, '');
      if (NUMBER.test(bare)) return Number(bare);
      // Only a URL needs the world's remote: a ref of any other form never reads it, so a world with no seed reads none.
      let remote: string;
      try {
        remote = store.read().remote;
      } catch {
        return undefined;
      }
      const pull = `${remote}/pull/`;
      const digits = ref.startsWith(pull) ? ref.slice(pull.length) : '';
      return NUMBER.test(digits) ? Number(digits) : undefined;
    },
    async push(cwd, branch) {
      if (branch === store.read().defaultBranch) {
        throw new PortError('codeHost', 'push', 'invalid', `${branch} is the default branch`);
      }
      let headSha: string;
      try {
        const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
          cwd,
          ...(options.env ? { env: { ...options.env } } : {}),
        });
        if (git.exitCode !== 0) throw new Error(git.stderr.toString().trim());
        headSha = git.stdout.toString().trim();
      } catch (error) {
        throw new PortError('codeHost', 'push', 'invalid', `${cwd} is not a git checkout: ${(error as Error).message}`);
      }
      store.change((world) => {
        world.branches[branch] = headSha;
        // An open pull request from the branch moves to the new head, whose checks start again.
        for (const pr of world.pullRequests) {
          if (pr.state !== 'open' || pr.head !== branch || pr.headSha === headSha) continue;
          pr.headSha = headSha;
          pr.reads.checks = 0;
        }
      });
      emit({ type: 'codehost:pushed', branch, headSha });
      return { branch, headSha, raw: { branch, headSha } };
    },
    async openPullRequest(request) {
      const opened = store.change((world): { pr: PullRequest; added: string[] | undefined } => {
        const headSha = world.branches[request.head];
        if (headSha === undefined) {
          throw new PortError('codeHost', 'openPullRequest', 'invalid', `${request.head} was never pushed`);
        }
        // Opening again from an open pull request's head into its base returns it, with the labels it lacks (D2).
        const open = world.pullRequests.find(
          (each) => each.state === 'open' && each.head === request.head && each.base === request.base,
        );
        if (open !== undefined) {
          const added = [...new Set(request.labels ?? [])].filter((name) => relabel(open, 'added', name));
          return { pr: toPullRequest(world, open), added };
        }
        const stored = StoredPullRequest.parse({
          number: Math.max(0, ...world.pullRequests.map((each) => each.number)) + 1,
          title: request.title,
          body: request.body,
          base: request.base,
          head: request.head,
          headSha,
          draft: request.draft ?? false,
          state: 'open',
          labels: [...(request.labels ?? [])],
          ...(request.ticketKey === undefined ? {} : { ticketKey: request.ticketKey }),
          ...(world.opened?.checks === undefined ? {} : { checks: world.opened.checks }),
          ...(world.opened?.merges === undefined ? {} : { merges: world.opened.merges }),
        });
        world.pullRequests.push(stored);
        return { pr: toPullRequest(world, stored), added: undefined };
      });
      const { pr, added } = opened;
      if (added !== undefined) {
        for (const name of added) emit({ type: 'codehost:labelled', number: pr.number, label: name, change: 'added' });
        return pr;
      }
      const { number, url, draft, base, head, ticketKey } = pr;
      emit({
        type: 'codehost:pr_opened',
        number,
        url,
        draft,
        base,
        head,
        ...(ticketKey === undefined ? {} : { ticketKey }),
      });
      for (const name of pr.labels) emit({ type: 'codehost:labelled', number, label: name, change: 'added' });
      return pr;
    },
    async listDesignated(name) {
      const world = store.read();
      return world.pullRequests
        .filter((pr) => pr.state === 'open' && !pr.draft && holdsLabel(pr.labels, name) && pr.fork !== true)
        .sort((a, b) => a.number - b.number)
        .map((pr) => toPullRequest(world, pr));
    },
    async getPullRequest(number) {
      const world = store.read();
      return details(world, find(world, 'getPullRequest', number));
    },
    async checks(number) {
      const checks = store.change((world) => {
        const pr = find(world, 'checks', number);
        const read = pr.checks.map(({ name, statuses }) => ({ name, status: scripted(statuses, pr.reads.checks) }));
        pr.reads.checks++;
        return { number, headSha: pr.headSha, checks: read, raw: structuredClone(pr) };
      });
      emit({ type: 'codehost:checks', number, headSha: checks.headSha, checks: checks.checks });
      return checks;
    },
    async merge(number, request) {
      // A request from outside TypeScript, such as `sail port`, is checked before anything is read.
      const parsed = MergeRequest.safeParse(request);
      if (!parsed.success) throw new PortError('codeHost', 'merge', 'invalid', mergeRequestIssue(request));
      const { method, expectedHeadSha } = parsed.data;
      const { result, merged, rejected } = store.change(
        (world): { result: MergeResult; merged: boolean; rejected: boolean } => {
          const pr = find(world, 'merge', number);
          const answer = (state: 'refused' | 'pending', reason: string) => ({
            result: { state, reason, raw: structuredClone(pr) },
            merged: false,
            rejected: false,
          });
          // A merge already reported is reported again, but announced only the first time.
          if (pr.state === 'merged') {
            return {
              result: { state: 'merged', sha: mergeSha(pr), raw: structuredClone(pr) },
              merged: false,
              rejected: false,
            };
          }
          // A host merges neither a closed pull request nor a draft, nor one whose head has moved.
          if (pr.state === 'closed' || pr.draft) {
            return answer('refused', `fake: pull request #${number} is ${pr.draft ? 'a draft' : 'closed'}`);
          }
          if (pr.headSha !== expectedHeadSha) {
            return answer(
              'refused',
              `fake: head moved: expected ${expectedHeadSha}, pull request #${number} is at ${pr.headSha}`,
            );
          }
          const scriptedAnswer = scripted(pr.merges, pr.reads.merges);
          pr.reads.merges++;
          if (scriptedAnswer === 'rejected') {
            return { ...answer('refused', 'rejected'), rejected: true };
          }
          if (scriptedAnswer !== 'merged') return answer(scriptedAnswer, `fake: merge scripted ${scriptedAnswer}`);
          pr.state = 'merged';
          return {
            result: { state: 'merged', sha: mergeSha(pr), raw: structuredClone(pr) },
            merged: true,
            rejected: false,
          };
        },
      );
      // Rejected once the read is saved: the host refused the merge, and nothing merged.
      if (rejected) throw new PortError('codeHost', 'merge', 'conflict', 'fake: merge rejected (scripted)');
      if (merged && result.state === 'merged') emit({ type: 'codehost:merged', number, method, sha: result.sha });
      return result;
    },
    addLabel: async (number, name) => label('addLabel', number, name),
    removeLabel: async (number, name) => label('removeLabel', number, name),
    async comment(number, body) {
      const posted = store.change((world) => {
        const pr = find(world, 'comment', number);
        pr.comments.push({ author: 'sail', body, createdAt: now().toISOString() });
        const id = `comment-${pr.comments.length}`;
        return { id, url: `${world.remote}/pull/${number}#${id}`, raw: structuredClone(pr) };
      });
      emit({ type: 'codehost:commented', number, body });
      return posted;
    },
    capabilities: () => ({ checks: true, labels: true, drafts: true, mergeMethods: ['merge', 'squash', 'rebase'] }),
  };
}
