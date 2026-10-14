// What makes a watched workflow one the watcher can act on: the runtime rules `sail check` adds to the SDK's types.
// Stubbed for queue-store-and-polling: TASK-001 writes the rules.
import type { Workflow } from '../sdk/index';
import type { SourceKind } from '../sdk/intake';
import { DEFAULT_LABEL, type ProjectConfig } from './config';

/** The source kinds the watcher can poll for. */
export const POLLABLE_KINDS: readonly SourceKind[] = ['ticket'];

/** The shortest `watch.every`. */
export const MIN_EVERY_MS = 30_000;

/** A `watch.every` in milliseconds: `<n>s`, `<n>m` or `<n>h` of at least `MIN_EVERY_MS`. Anything else is undefined. */
export function parseEvery(_every: unknown): number | undefined {
  return 0;
}

/** What keeps the watcher from acting on `workflow`'s watch declaration, or undefined when nothing does. */
export function watchProblem(_workflow: Workflow): string | undefined {
  return 'not checked yet';
}

/** The label a watched workflow polls for: its own, then `project.yaml`'s, then sail's. */
export function watchLabel(_workflow: Workflow, _config: Pick<ProjectConfig, 'label'>): string {
  return DEFAULT_LABEL;
}
