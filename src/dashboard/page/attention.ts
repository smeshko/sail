// Needs attention: one list, across every repository, of what a person should look at. It comes from the index alone,
// whose runs carry their summaries and whose repositories carry their queues, so no run is opened to build it. Each
// item says what to open: its run, its call, and the inspector's tab, where the run's own files explain it.
//
// Stub (TASK-005): signatures only.
import type { IndexRepo } from '../files';

export type AttentionKind = 'failed' | 'suspended' | 'error' | 'denial' | 'parked' | 'problem';

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

/** Every item that needs attention: by repository name, then newest run first, then call order; parked and problems last. */
export function attention(_index: readonly IndexRepo[]): AttentionItem[] {
  return [];
}
