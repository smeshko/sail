// The fake CodeHost: pull requests in a committed seed file, with changes kept in a separate state file (D1). Checks
// and merges can be scripted per pull request, and how many times each was read is kept in the state file, so a
// scripted sequence carries on in the next process.
import { z } from 'zod';
import type { ProviderEvent } from '../../events/types';
import type { CodeHost } from '../../ports/code-host';
import { PortError } from '../../ports/errors';
import type { ProviderOptions } from '../../ports/ticket-source';
import { CheckStatus, Comment, type Labelled, type MergeResult, type PullRequest } from '../../ports/types';
import { createStore } from './store';

export interface FakeCodeHostOptions extends ProviderOptions {
  /** The committed world. Never written. */
  readonly seed: string;
  /** Where the world's changes are kept. Read instead of `seed` once it exists. */
  readonly state: string;
  /** The environment for the git the fake runs. */
  readonly env?: Readonly<Record<string, string>>;
}

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
  checks: z.array(z.object({ name: z.string(), statuses: z.array(CheckStatus).min(1) })).default([]),
  /** What each merge call is answered, the last repeating. */
  merges: z
    .array(z.enum(['merged', 'pending', 'refused']))
    .min(1)
    .default(['merged']),
  reads: z.object({ checks: z.number().int(), merges: z.number().int() }).default({ checks: 0, merges: 0 }),
  comments: z.array(Comment).default([]),
});
type StoredPullRequest = z.infer<typeof StoredPullRequest>;

const World = z.object({
  /** Stands in for the host's URL: a pull request's is `<remote>/pull/<number>`. */
  remote: z.string(),
  defaultBranch: z.string(),
  /** Each pushed branch's head sha. */
  branches: z.record(z.string(), z.string()),
  pullRequests: z.array(StoredPullRequest),
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
  const find = (world: World, op: string, number: number): StoredPullRequest => {
    const found = world.pullRequests.find((pr) => pr.number === number);
    if (found === undefined) throw new PortError('codeHost', op, 'not_found', `no pull request #${number}`);
    return found;
  };
  const label = (op: 'addLabel' | 'removeLabel', number: number, name: string): Labelled => {
    const { labelled, changed } = store.change((world) => {
      const pr = find(world, op, number);
      const changed = pr.labels.includes(name) !== (op === 'addLabel');
      if (changed) pr.labels = op === 'addLabel' ? [...pr.labels, name] : pr.labels.filter((each) => each !== name);
      return { labelled: { number, labels: [...pr.labels], raw: structuredClone(pr) }, changed };
    });
    if (changed)
      emit({ type: 'codehost:labelled', number, label: name, change: op === 'addLabel' ? 'added' : 'removed' });
    return labelled;
  };

  return {
    name: 'fake',
    parseRef(ref) {
      const pull = `${store.read().remote}/pull/`;
      const digits = ref.startsWith(pull) ? ref.slice(pull.length) : ref.replace(/^#/, '');
      return NUMBER.test(digits) ? Number(digits) : undefined;
    },
    async push(cwd, branch) {
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
      });
      emit({ type: 'codehost:pushed', branch, headSha });
      return { branch, headSha, raw: { branch, headSha } };
    },
    async openPullRequest(request) {
      const pr = store.change((world) => {
        const headSha = world.branches[request.head];
        if (headSha === undefined) {
          throw new PortError('codeHost', 'openPullRequest', 'invalid', `${request.head} was never pushed`);
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
        });
        world.pullRequests.push(stored);
        return toPullRequest(world, stored);
      });
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
        .filter((pr) => pr.state === 'open' && !pr.draft && pr.labels.includes(name))
        .sort((a, b) => a.number - b.number)
        .map((pr) => toPullRequest(world, pr));
    },
    async getPullRequest(number) {
      const world = store.read();
      return toPullRequest(world, find(world, 'getPullRequest', number));
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
    async merge(number, method) {
      const { result, merged } = store.change((world): { result: MergeResult; merged: boolean } => {
        const pr = find(world, 'merge', number);
        // A merge already reported is reported again, but announced only the first time.
        if (pr.state === 'merged') {
          return { result: { state: 'merged', sha: mergeSha(pr), raw: structuredClone(pr) }, merged: false };
        }
        if (pr.state === 'closed') {
          const reason = `fake: pull request #${number} is closed`;
          return { result: { state: 'refused', reason, raw: structuredClone(pr) }, merged: false };
        }
        const answer = scripted(pr.merges, pr.reads.merges);
        pr.reads.merges++;
        if (answer !== 'merged') {
          const reason = `fake: merge scripted ${answer}`;
          return { result: { state: answer, reason, raw: structuredClone(pr) }, merged: false };
        }
        pr.state = 'merged';
        return { result: { state: 'merged', sha: mergeSha(pr), raw: structuredClone(pr) }, merged: true };
      });
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
