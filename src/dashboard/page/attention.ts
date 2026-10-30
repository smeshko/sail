// Needs attention: one list, across every repository, of what a person should look at. It comes from the index alone,
// whose runs carry their summaries and whose repositories carry their queues, so no run is opened to build it. Each
// item says what to open: its run, its call, and the inspector's tab, where the run's own files explain it. A run's
// denials are one item, however many of its calls had them.

import type { IndexRepo } from '../files';
import { shellWord } from './commands';
import { newestFirst, statusOf, stopReasonOf } from './index-model';

export type AttentionKind = 'failed' | 'suspended' | 'error' | 'denial' | 'parked' | 'problem' | 'stalled';

/** What an item opens in the shell. */
export interface Opens {
  repo: string;
  runId: string;
  key?: string;
  tab?: string;
}

export interface AttentionItem {
  repo: string;
  runId?: string;
  key?: string;
  workflow?: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  opens?: Opens;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function repoItems(repo: IndexRepo): AttentionItem[] {
  const items: AttentionItem[] = [];
  const problems: AttentionItem[] = [];
  const name = repo.name;
  if (repo.problem !== undefined)
    problems.push({ repo: name, kind: 'problem', title: 'repository', detail: repo.problem });
  for (const run of newestFirst(repo.runs)) {
    const { runId } = run;
    const opens = { repo: name, runId };
    const status = statusOf(run);
    const stopReason = stopReasonOf(run) ?? 'no stop reason';
    const ticket = run.summary?.ticket;
    const about = ticket === undefined ? '' : `${ticket.ticketKey} ${ticket.title}`;
    const message = run.summary?.message;
    if (status === 'failed') {
      const detail = [about, message].filter((part) => part !== undefined && part !== '').join(' · ');
      items.push({ repo: name, runId, kind: 'failed', title: `failed: ${stopReason}`, detail, opens });
    }
    if (status === 'suspended') {
      const resume = `sail resume ${shellWord(runId)}`;
      const detail = message === undefined ? resume : `${message} · ${resume}`;
      items.push({ repo: name, runId, kind: 'suspended', title: `suspended: ${stopReason}`, detail, opens });
    }
    if (status === 'running') {
      for (const { key, since } of run.summary?.stalled ?? []) {
        items.push({
          repo: name,
          runId,
          key,
          kind: 'stalled',
          title: 'stalled',
          detail: `${key} · no event since ${since}`,
          opens: { ...opens, key: key.split('/')[0] ?? key, tab: 'overview' },
        });
      }
    }
    const denying: { key: string; denials: number }[] = [];
    for (const call of run.summary?.calls ?? []) {
      const { key } = call;
      if (call.outcome === 'error') {
        const detail = call.summary ?? '';
        items.push({
          repo: name,
          runId,
          key,
          kind: 'error',
          title: `${key} ended in error`,
          detail,
          opens: { ...opens, key },
        });
      }
      if ((call.denials ?? 0) > 0) denying.push({ key, denials: call.denials ?? 0 });
    }
    // A run's denials are one item, naming each call that had them, which opens the first one's permissions.
    const first = denying[0];
    if (first !== undefined) {
      const total = denying.reduce((sum, each) => sum + each.denials, 0);
      items.push({
        repo: name,
        runId,
        kind: 'denial',
        title: plural(total, 'denial'),
        detail: denying.map((each) => `${each.key}: ${each.denials}`).join(' · '),
        opens: { ...opens, key: first.key, tab: 'permissions' },
      });
    }
    if (run.problem !== undefined)
      problems.push({ repo: name, runId, kind: 'problem', title: 'run', detail: run.problem, opens });
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
        title: `${item.dedupKey} parked after ${plural(item.attempts, 'attempt')}`,
        detail: item.reason ?? '',
      };
      if (item.runId !== undefined && listed.has(item.runId)) {
        parked.runId = item.runId;
        parked.opens = { repo: name, runId: item.runId };
      }
      items.push(parked);
    }
    if (view.problem !== undefined)
      problems.push({ repo: name, workflow, kind: 'problem', title: 'queue', detail: view.problem });
  }
  return [...items, ...problems];
}

/** Every item that needs attention: by repository name, then newest run first, then call order; parked and problems last. */
export function attention(index: readonly IndexRepo[]): AttentionItem[] {
  return [...index].sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name))).flatMap(repoItems);
}
