// What makes a watched workflow one the watcher can act on. The SDK's types already refuse a watch without its bound,
// a malformed `every` and a misspelt option, at `sail check`'s type-check. They can't see a bound of 0, an `every` of
// `0s`, an empty label, an intake that accepts nothing the watcher can poll, or a value cast past them, so
// `loadDefinitions()` checks the declared values here.
//
// - `every` has a floor of 30 s: a Linear poll costs one request plus one per ticket, and a key allows about 1,500 an
//   hour, so a shorter interval on a few workflows would spend it.
// - Only ticket sources are polled so far. Epic 14.2 adds `pr` to `POLLABLE_KINDS`, with the CodeHost poll.
import type { Workflow } from '../sdk/index';
import type { SourceKind } from '../sdk/intake';
import { DEFAULT_LABEL, type ProjectConfig } from './config';

/** The source kinds the watcher can poll for. */
export const POLLABLE_KINDS: readonly SourceKind[] = ['ticket'];

/** The shortest `watch.every`. */
export const MIN_EVERY_MS = 30_000;

const EVERY = /^(\d+(?:\.\d+)?)(s|m|h)$/;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** A `watch.every` in milliseconds: `<n>s`, `<n>m` or `<n>h` of at least `MIN_EVERY_MS`. Anything else is undefined. */
export function parseEvery(every: unknown): number | undefined {
  const match = typeof every === 'string' ? EVERY.exec(every) : null;
  if (match === null) return undefined;
  const ms = Math.round(Number(match[1]) * (UNIT_MS[match[2] as string] as number));
  return ms >= MIN_EVERY_MS ? ms : undefined;
}

/** What keeps the watcher from acting on `workflow`'s watch declaration, or undefined when nothing does. */
export function watchProblem(workflow: Workflow): string | undefined {
  const { watch, maxConcurrentRuns, intake } = workflow;
  if (watch === undefined && maxConcurrentRuns === undefined) return undefined;
  if (maxConcurrentRuns === undefined) {
    return 'declares watch without maxConcurrentRuns: a watched workflow bounds its runs';
  }
  if (watch === undefined) return 'declares maxConcurrentRuns without watch: only a watched workflow bounds its runs';
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
    return `has maxConcurrentRuns ${JSON.stringify(maxConcurrentRuns)}, which is not a whole number of 1 or more`;
  }
  if (parseEvery(watch.every) === undefined) {
    return `has watch.every ${JSON.stringify(watch.every)}, which is not a number of s, m or h of at least 30s`;
  }
  const { label } = watch as { label?: unknown };
  if (label !== undefined && (typeof label !== 'string' || label.trim() === '')) {
    return `has watch.label ${JSON.stringify(label)}, and a label is a non-empty string`;
  }
  if (!intake.accepts.some((kind) => POLLABLE_KINDS.includes(kind))) {
    const accepts = intake.accepts.length > 0 ? intake.accepts.join(', ') : 'nothing';
    return `its intake '${intake.name}' accepts ${accepts}, and sail polls only ticket sources so far`;
  }
  return undefined;
}

/** The label a watched workflow polls for: its own, then `project.yaml`'s, then sail's. */
export function watchLabel(workflow: Workflow, config: Pick<ProjectConfig, 'label'>): string {
  return workflow.watch?.label ?? config.label ?? DEFAULT_LABEL;
}
