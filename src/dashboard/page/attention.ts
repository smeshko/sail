// Needs attention: one list, across every repository, of what a person should look at. It comes from the index alone,
// whose runs carry their summaries and whose repositories carry their queues, so no run is opened to build it. Each
// item says what to open: its run and its call, where the run's own files explain it. Only failures are listed, one
// row per run that failed or has a call in error (carrying its reasons), a parked item and a problem. Each item leads
// with what it is about, as a list row leads with its ID: its run's ticket key or pull request, its item's, its queue's
// workflow or its repository.

import type { IndexRepo } from '../files';
import { newestFirst, statusOf, stopReasonOf } from './index-model';

export type AttentionKind = 'failed' | 'error' | 'parked' | 'problem';

/** What an item opens in the shell. */
export interface Opens {
  repo: string;
  runId: string;
  key?: string;
}

export interface AttentionItem {
  repo: string;
  runId?: string;
  key?: string;
  workflow?: string;
  kind: AttentionKind;
  /** What the item is about, which its row leads with: a ticket key, `PR #n`, a run id, a workflow or a repository. */
  about: string;
  title: string;
  detail: string;
  opens?: Opens;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The ID a run is listed by: its pull request, else its ticket key, else its run id. */
function runAbout(run: IndexRepo['runs'][number]): string {
  const source = run.summary?.source ?? run.source;
  if (source?.kind === 'pr') return `PR #${source.number}`;
  return run.summary?.ticket?.ticketKey ?? (source?.kind === 'ticket' ? source.ticketKey : undefined) ?? run.runId;
}

/** A queue item's key as a person reads it: `ticket:FAKE-6` is `FAKE-6`, `pr:12` is `PR #12`. */
export const itemAbout = (dedupKey: string): string =>
  dedupKey.startsWith('pr:') ? `PR #${dedupKey.slice(3)}` : dedupKey.replace(/^ticket:/, '');

function repoItems(repo: IndexRepo): AttentionItem[] {
  const items: AttentionItem[] = [];
  const problems: AttentionItem[] = [];
  const name = repo.name;
  if (repo.problem !== undefined)
    problems.push({ repo: name, kind: 'problem', about: name, title: 'repository', detail: repo.problem });
  for (const run of newestFirst(repo.runs)) {
    const { runId } = run;
    const opens = { repo: name, runId };
    const status = statusOf(run);
    const stopReason = stopReasonOf(run) ?? 'no stop reason';
    const about = runAbout(run);
    const message = run.summary?.message;
    const calls = run.summary?.calls ?? [];
    const errors = calls.filter((call) => call.outcome === 'error');
    const last = errors.at(-1);
    if (status === 'failed' || last !== undefined) {
      const others = errors.filter((call) => call !== last).map((call) => call.key);
      const denials = run.summary?.totals.denials ?? 0;
      const reasons = [
        status === 'failed' ? run.summary?.ticket?.title : last?.summary,
        status === 'failed' ? message : undefined,
        others.length > 0 ? `also in error: ${others.join(', ')}` : undefined,
        denials > 0 ? plural(denials, 'denial') : undefined,
      ];
      const item: AttentionItem = {
        repo: name,
        runId,
        kind: status === 'failed' ? 'failed' : 'error',
        about,
        title: status === 'failed' ? `failed: ${stopReason}` : `${last?.key} ended in error`,
        detail: reasons.filter((part) => part !== undefined && part !== '').join(' · '),
        opens,
      };
      if (last !== undefined) {
        item.key = last.key;
        item.opens = { ...opens, key: last.key };
      }
      items.push(item);
    }
    if (run.problem !== undefined)
      problems.push({ repo: name, runId, kind: 'problem', about, title: 'run', detail: run.problem, opens });
  }
  const listed = new Set(repo.runs.map((run) => run.runId));
  for (const view of repo.queues) {
    const { workflow } = view;
    for (const item of view.queue?.items ?? []) {
      if (item.state !== 'parked') continue;
      const parked: AttentionItem = {
        repo: name,
        workflow,
        kind: 'parked',
        about: itemAbout(item.dedupKey),
        title: `parked after ${plural(item.attempts, 'attempt')}`,
        detail: item.reason ?? '',
      };
      if (item.runId !== undefined && listed.has(item.runId)) {
        parked.runId = item.runId;
        parked.opens = { repo: name, runId: item.runId };
      }
      items.push(parked);
    }
    if (view.problem !== undefined)
      problems.push({ repo: name, workflow, kind: 'problem', about: workflow, title: 'queue', detail: view.problem });
  }
  return [...items, ...problems];
}

/** Every item that needs attention: by repository name, then one row per run, newest first; parked and problems last. */
export function attention(index: readonly IndexRepo[]): AttentionItem[] {
  return [...index].sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name))).flatMap(repoItems);
}

/** What an item is known by once a person has cleared it: every field that says what it is. */
export function identity(item: AttentionItem): string {
  const { repo, kind, runId, key, workflow, about, title, detail } = item;
  return JSON.stringify([repo, kind, runId ?? null, key ?? null, workflow ?? null, about, title, detail]);
}
