// The environment variables that tie git to one repository: what `git rev-parse --local-env-vars` lists, but the
// user's own `-c` config (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`), which git keeps when it enters another
// repository too. git exports them to its hooks, so a sail started from a hook would point every git it starts at the
// clone, its index and HEAD included, whatever directory that git runs in. The Workspace adapters' git, the fake code
// host's git and every script step outside the clone go without them. A stage run in isolation keeps them, since it
// runs in the clone.

const REPOSITORY_VARIABLES: ReadonlySet<string> = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]);

/** `env` without the variables that tie git to one repository, and without the unset ones. */
export function withoutRepositoryVariables(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !REPOSITORY_VARIABLES.has(entry[0]),
    ),
  );
}
