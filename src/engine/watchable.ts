// What makes a watched workflow one the watcher can act on. The SDK's types already refuse a watch without its bound,
// a malformed `every` and a misspelt option, at `sail check`'s type-check. They can't see a bound of 0, an `every` of
// `0s`, an empty label, an intake that accepts nothing the watcher can poll, or a value cast past them, so
// `loadDefinitions()` checks the declared values here.
//
// - `every` has a floor of 30 s: a Linear poll costs one request plus one per ticket, and a key allows about 1,500 an
//   hour, so a shorter interval on a few workflows would spend it.
// - `every` has a ceiling too, the longest a timer can wait: past it, `setTimeout` fires after 1 ms, and the watcher
//   would poll without pause.
// - Tickets are polled through the TicketSource, and pull requests through the CodeHost. A watched workflow polls one kind:
//   the one its intake accepts, so an intake that accepts both, or neither, is refused (14.2's D9).
import type { Workflow } from '../sdk/index';
import type { SourceKind } from '../sdk/intake';
import { DEFAULT_LABEL, type ProjectConfig } from './config';

/** The source kinds the watcher can poll for. */
export const POLLABLE_KINDS: readonly SourceKind[] = ['ticket', 'pr'];

/** The shortest `watch.every`. */
export const MIN_EVERY_MS = 30_000;

/** The longest `watch.every`: the longest a timer can wait, 2^31 - 1 ms. */
export const MAX_EVERY_MS = 2_147_483_647;

const EVERY = /^(\d+(?:\.\d+)?)(s|m|h)$/;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** `every` in milliseconds, when it reads `<n>s`, `<n>m` or `<n>h`, whatever its size. */
function everyMs(every: unknown): number | undefined {
  const match = typeof every === 'string' ? EVERY.exec(every) : null;
  if (match === null) return undefined;
  return Math.round(Number(match[1]) * (UNIT_MS[match[2] as string] as number));
}

/**
 * A `watch.every` in milliseconds: `<n>s`, `<n>m` or `<n>h` from `MIN_EVERY_MS` to `MAX_EVERY_MS`. Anything else is
 * undefined.
 */
export function parseEvery(every: unknown): number | undefined {
  const ms = everyMs(every);
  return ms !== undefined && ms >= MIN_EVERY_MS && ms <= MAX_EVERY_MS ? ms : undefined;
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
  if ((everyMs(watch.every) ?? 0) > MAX_EVERY_MS) {
    const longest = `${MAX_EVERY_MS} ms (about 596h), the longest a timer can wait`;
    return `has watch.every ${JSON.stringify(watch.every)}, which is longer than ${longest}`;
  }
  if (parseEvery(watch.every) === undefined) {
    return `has watch.every ${JSON.stringify(watch.every)}, which is not a number of s, m or h of at least 30s`;
  }
  const { label } = watch as { label?: unknown };
  if (label !== undefined && (typeof label !== 'string' || label.trim() === '')) {
    return `has watch.label ${JSON.stringify(label)}, and a label is a non-empty string`;
  }
  const pollable = intake.accepts.filter((kind) => POLLABLE_KINDS.includes(kind));
  if (pollable.length === 0) {
    const accepts = intake.accepts.length > 0 ? intake.accepts.join(', ') : 'nothing';
    return `its intake '${intake.name}' accepts ${accepts}, and sail polls only ${POLLABLE_KINDS.join(' and ')} sources`;
  }
  if (pollable.length > 1) {
    return `its intake '${intake.name}' accepts ${pollable.join(' and ')}, and a watched workflow polls one kind of source`;
  }
  return undefined;
}

/** The one source kind a watched workflow's intake accepts that the watcher can poll. */
export function pollKind(workflow: Workflow): SourceKind {
  return workflow.intake.accepts.find((kind) => POLLABLE_KINDS.includes(kind)) ?? 'ticket';
}

/** The label a watched workflow polls for: its own, then `project.yaml`'s, then sail's. */
export function watchLabel(workflow: Workflow, config: Pick<ProjectConfig, 'label'>): string {
  return workflow.watch?.label ?? config.label ?? DEFAULT_LABEL;
}
