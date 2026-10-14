// A run's branch: `<branchPrefix><ticket key>-<slug>`. Stubs for TASK-003 (ADW-93): the signatures, with wrong values.

/** What `project.yaml`'s `branchPrefix` falls back to. */
export const DEFAULT_BRANCH_PREFIX = 'sail/';

/** The title as a branch segment. */
export function slugOf(_title: string): string {
  return '';
}

/** The branch of a run on `ticketKey`. */
export function branchFor(prefix: string, ticketKey: string, _title: string): string {
  return `${prefix}${ticketKey}`;
}
