// `workspace: { use: git-worktree }` is a built-in: it resolves by name for the workspace port, and an unknown name's
// refusal lists it among the built-ins that fill that port (TASK-005).
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { BUILTINS } from '../../src/adapters/index';
import { resolveAdapters } from '../../src/engine/adapters';
import { readConfig } from '../../src/engine/config';
import { edit } from '../helpers/fixture';
import { writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

/** The stub repository's `.sail/`, with its workspace named `use` in `project.yaml`, resolved with the built-ins. */
async function resolvedWith(repoDir: string, env: Record<string, string>, use: string) {
  const sail = join(repoDir, '.sail');
  writeStub(repoDir);
  edit(sail, 'project.yaml', 'workspace: { use: fake }', `workspace: { use: ${use} }`);
  const config = readConfig(sail);
  if ('issues' in config) throw new Error(`the stub's config is invalid: ${JSON.stringify(config.issues)}`);
  return resolveAdapters({ sailDir: sail, config, builtins: BUILTINS, env });
}

// STICKER: git-worktree is registered as a built-in in TASK-005.

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('a repository that names git-worktree for its workspace resolves it to that adapter', async () => {
    await withTempRepo(async (repo) => {
      const resolved = await resolvedWith(repo.dir, repo.env, 'git-worktree');
      expect('issues' in resolved).toBe(false);
      if ('issues' in resolved) throw new Error('unreachable');
      expect(resolved.entries.workspace.use).toBe('git-worktree');
    });
  });

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ("a workspace name nothing fills refuses, listing git-worktree among the built-ins that fill the workspace port", async () => {
    await withTempRepo(async (repo) => {
      const resolved = await resolvedWith(repo.dir, repo.env, 'no-such-workspace');
      expect('issues' in resolved).toBe(true);
      if (!('issues' in resolved)) throw new Error('unreachable');
      expect(JSON.stringify(resolved.issues)).toContain('fake, git-worktree');
    });
  });
