// The two permission profiles every agent stage of this .sail/ runs under, so a command the agents reach for is
// allowed once, here, and not stage by stage. What guards a run is the worktree it works in, the write globs, the
// engine's deny set, and the outward actions (push, pull request, merge, ticket moves) living in script stages: so a
// stage may run any command, and `deny` names only what reaches out of the run or, for a reader, changes the branch.
import type { Permissions } from 'sail';

/** What no agent of this repository runs: anything that reaches outside the run, or another process on the machine. */
const OUTWARD = [
  'git push *',
  'git remote *',
  'git worktree *',
  'git config *',
  'gh *',
  'curl *',
  'wget *',
  'ssh *',
  'scp *',
  'rsync *',
  'nc *',
  'npm *',
  'npx *',
  'bun publish *',
  'bun pm *',
  'sail *',
  'bin/sail *',
  'security *',
  'open *',
  'osascript *',
  'kill *',
  'pkill *',
  'killall *',
];

/** The repository's own paths, which a stage that changes the branch writes. */
const REPOSITORY = [
  'src/**',
  'test/**',
  'types/**',
  'schemas/**',
  'bin/**',
  'scripts/**',
  '.sail/**',
  '.githooks/**',
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'tsconfig.json',
  'biome.json',
  'AGENTS.md',
  'CONTEXT.md',
];

/**
 * A stage that reads the change and writes only its own files: it runs tests and any read it needs, and never commits,
 * moves files, installs or rewrites the branch.
 */
export const readonly: Permissions = {
  read: ['**'],
  write: ['$STAGE_OUT/**'],
  commands: ['*'],
  deny: [
    ...OUTWARD,
    'git add *',
    'git commit *',
    'git rm *',
    'git mv *',
    'git restore *',
    'git stash *',
    'git reset *',
    'git rebase *',
    'git merge *',
    'git cherry-pick *',
    'git revert *',
    'git am *',
    'git apply *',
    'git tag *',
    'bun add *',
    'bun install *',
    'bun remove *',
    'bun update *',
    'bun run fix *',
    'bun run types *',
    'bun run golden *',
    'rm *',
    'mv *',
    'sed -i*',
  ],
};

/**
 * A stage that changes the branch: it writes the repository's own paths, commits, adds a dependency and runs anything
 * else, but never pushes or reaches outside the run. Files go with `git rm` and
 * `git mv`, so a removal is always in a commit.
 */
export const builder: Permissions = {
  read: ['**'],
  write: [...REPOSITORY, '$STAGE_OUT/**'],
  commands: ['*'],
  deny: [...OUTWARD, 'rm *'],
};

/** `profile` with `tools` added, such as WebFetch for a stage that reads an outside API's docs. */
export function withTools(profile: Permissions, tools: readonly string[]): Permissions {
  return { ...profile, tools: [...(profile.tools ?? []), ...tools] };
}
