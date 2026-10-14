// A run's branch: `<branchPrefix><ticket key>-<slug>`, the one name its lease is keyed by and its steps push (D3). The
// engine names it before anything else of the run exists, since the lease comes first, from the ticket's title as the
// start fetched it. A title edited later would give another name, and a lease on the old one would no longer guard the
// pushed branch: so the name is fixed once, written to `run.json`, and a resume reads it from there and never derives
// it again.

/** What `project.yaml`'s `branchPrefix` falls back to. */
export const DEFAULT_BRANCH_PREFIX = 'sail/';

/** The longest slug a branch name takes. */
const SLUG_MAX = 40;

/**
 * The title as a branch segment: ASCII lower-case letters and digits, each run of anything else one `-`, with none at
 * either end, cut at a `-` to at most 40 characters.
 */
export function slugOf(title: string): string {
  let slug = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > SLUG_MAX) {
    const cut = slug.slice(0, SLUG_MAX + 1);
    const dash = cut.lastIndexOf('-');
    slug = (dash > 0 ? cut.slice(0, dash) : slug.slice(0, SLUG_MAX)).replace(/-+$/, '');
  }
  return slug;
}

/** The branch of a run on `ticketKey`: the key keeps its case, with anything outside `[A-Za-z0-9._-]` turned into `-`. */
export function branchFor(prefix: string, ticketKey: string, title: string): string {
  const key = ticketKey.replace(/[^A-Za-z0-9._-]/g, '-');
  const slug = slugOf(title);
  return slug === '' ? `${prefix}${key}` : `${prefix}${key}-${slug}`;
}
