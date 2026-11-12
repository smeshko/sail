// Whether two plans change the same files, for groom's overlap stage: the paths a plan's tasks name, the paths two plans
// share, the plan attached last among a ticket's files, and the order in which overlapping tickets are tried as the one
// to wait on. Pure: no port call and no file read, and the reader of a plan's tasks is handed in, so the module imports
// nothing.

/** The paths that never count as overlap: nearly every plan adds a term to the glossary. */
export const IGNORED = ['CONTEXT.md'];

/** The trailer's line: the last line of an attached plan, an HTML comment holding the AttachedPlan as JSON. */
const TRAILER = /^<!-- sail:plan (\{.*\}) -->$/;

/**
 * The paths the plan's tasks name in their Files blocks, each once and without a leading `./`, less those in `IGNORED`.
 * `parseTasks` is jev-check.mjs's.
 */
export function planPaths(planText, parseTasks) {
  const paths = parseTasks(planText).flatMap((task) => task.paths.map((path) => path.replace(/^(\.\/)+/, '')));
  return [...new Set(paths)].filter((path) => !IGNORED.includes(path));
}

/** The paths of `mine` that `theirs` holds, in `mine`'s order. */
export function sharedPaths(mine, theirs) {
  return mine.filter((path) => theirs.includes(path));
}

/**
 * The plan attached last among `files`, each `{ name, text }`: the one whose last line is a `sail:plan` trailer with the
 * greatest `attachedAt`, with that time beside it, or undefined when none is a plan. A trailer that is not JSON, or
 * holds no `attachedAt`, is passed over.
 */
export function lastPlan(files) {
  let last;
  for (const { name, text } of files) {
    const match = TRAILER.exec(text.trimEnd().split('\n').at(-1) ?? '');
    if (match === null) continue;
    let trailer;
    try {
      trailer = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (typeof trailer?.attachedAt !== 'string') continue;
    if (last === undefined || trailer.attachedAt > last.attachedAt) {
      last = { name, text, attachedAt: trailer.attachedAt };
    }
  }
  return last;
}

/**
 * The candidates, each `{ ticketKey, attachedAt, shared }`, that share a path, the plan attached last first, and by
 * ticket key between two attached at the same time.
 */
export function byRecency(candidates) {
  return candidates
    .filter((each) => each.shared.length > 0)
    .sort((a, b) => b.attachedAt.localeCompare(a.attachedAt) || a.ticketKey.localeCompare(b.ticketKey));
}

/** Why the ticket waits, as the comment words it: the first three shared paths, then how many more. */
export function why(shared) {
  const named = shared
    .slice(0, 3)
    .map((path) => `\`${path}\``)
    .join(', ');
  const more = shared.length - 3;
  return `its plan also changes ${named}${more > 0 ? ` and ${more} more` : ''}`;
}
