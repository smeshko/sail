// The fixture's `land` on `codeHost: { use: github, repository: o/r }`, end to end from the CLI, offline: the workspace
// on git-worktree with a local bare origin, the scripted GitHub served on 127.0.0.1 through SAIL_GITHUB_API_URL on that
// origin, and the ticket source and the harness fake. Each run is a `sail` process of its own, whose script steps'
// `sail port codehost` reach the world over HTTP. What GitHub was asked is read from the world's request log.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK } from '../../src/cli/exit-codes';
import { readEvents } from '../../src/events/consumers/ndjson';
import type { SailEvent } from '../../src/events/types';
import { addLand, copyFixture, edit } from '../helpers/fixture';
import { createGitHubWorld, type GitHubWorld, worldMergeSha } from '../helpers/github-world';
import { withOrigin } from '../helpers/origin';
import { withTempRepo } from '../helpers/temp-repo';

const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');
const TOKEN = 'ghp_MARKER_land_7c2d90a4';

interface Landed {
  code: number;
  stderr: string;
  world: GitHubWorld;
  events: SailEvent[];
}

/**
 * `sail FAKE-1 --workflow land` in a clone of the fixture on github: `.sail/` uncommitted, `.sail-runs/` ignored, a
 * bare origin the world reads its branches from, and the workspace on git-worktree. `prepare` changes the world first.
 */
async function landOnGitHub(prepare: (world: GitHubWorld) => void = () => {}): Promise<Landed> {
  return withTempRepo(async (repo) => {
    writeFileSync(join(repo.dir, '.gitignore'), '.sail-runs/\n');
    repo.git('add', '.gitignore');
    repo.git('commit', '-q', '-m', 'ignore the runs');
    const origin = withOrigin(repo).url;
    const sail = addLand(copyFixture(repo.dir));
    edit(sail, 'project.yaml', 'workspace: { use: fake }', 'workspace: { use: git-worktree }');
    edit(
      sail,
      'project.yaml',
      'codeHost: { use: fake, seed: ./fake/prs.json }',
      'codeHost: { use: github, repository: o/r }',
    );
    const world = createGitHubWorld({
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      bare: origin,
      env: repo.env,
      token: TOKEN,
    });
    prepare(world);
    const served = world.serve();
    try {
      const { SAIL_GITHUB_TOKEN: _sail, GITHUB_TOKEN: _github, ...base } = repo.env;
      const child = Bun.spawn([process.execPath, MAIN, 'FAKE-1', '--workflow', 'land'], {
        cwd: repo.dir,
        env: { ...base, GITHUB_TOKEN: TOKEN, SAIL_GITHUB_API_URL: served.url },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      const runs = join(repo.dir, '.sail-runs');
      const [id] = existsSync(runs) ? readdirSync(runs).filter((name) => name !== 'fake') : [];
      return { code, stderr, world, events: id === undefined ? [] : readEvents(join(runs, id)) };
    } finally {
      served.stop();
    }
  });
}

/** The requests to `route` (`<METHOD> <path>` under /repos/o/r), each as its body, or null when it had none. */
const bodiesOf = (world: GitHubWorld, route: string) =>
  world.requests
    .filter(
      (request) =>
        `${request.method} ${request.path.split('?')[0]}` === `${route.split(' ')[0]} /repos/o/r${route.split(' ')[1]}`,
    )
    .map((request) => request.body ?? null);

// biome-ignore format: TDD-PENDING TASK-008
test
  .skip // TDD-PENDING TASK-008
  ("land on GitHub removes sail with a DELETE, adds sail-landed with a POST of only that label, merges with a PUT of only the method and the head, and its codehost:merged holds GitHub's merge commit", async () => {
  const run = await landOnGitHub();
  const pr = run.world.pullRequests[0];
  const merged = run.events.filter((event) => event.type === 'codehost:merged');
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
  expect({
    deletes: bodiesOf(run.world, 'DELETE /issues/1/labels/sail'),
    labels: bodiesOf(run.world, 'POST /issues/1/labels'),
    merges: bodiesOf(run.world, 'PUT /pulls/1/merge'),
    merged: merged.map((event) => [(event as { key?: string }).key, (event as { sha: string }).sha]),
    held: [pr?.labels, pr?.mergeCommitSha],
  }).toEqual({
    deletes: [null],
    labels: [{ labels: ['sail'] }, { labels: ['sail-landed'] }],
    merges: [{ merge_method: 'squash', sha: pr?.headSha }],
    merged: [['merge#1', worldMergeSha(1, pr?.headSha ?? '')]],
    held: [['sail-landed'], worldMergeSha(1, pr?.headSha ?? '')],
  });
});

// biome-ignore format: TDD-PENDING TASK-008
test
  .skip // TDD-PENDING TASK-008
  ("a merge GitHub rejects with a 405 fails the run at merge#1 with an error:port holding GitHub's message, records no codehost:merged, and the pull request stays open", async () => {
  const run = await landOnGitHub((world) =>
    world.inject('PUT /pulls/1/merge', { status: 405, body: { message: 'Pull Request is not mergeable' } }),
  );
  const end = run.events.at(-1) as Record<string, unknown> | undefined;
  expect({
    code: run.code,
    end: [end?.type, end?.status, end?.stopReason],
    failed: run.events
      .filter((event) => event.type === 'error:port')
      .map((event) => [(event as { key?: string }).key, (event as { message: string }).message]),
    merged: run.events.filter((event) => event.type === 'codehost:merged'),
    open: [run.world.pullRequests[0]?.state, run.world.pullRequests[0]?.mergedAt],
  }).toEqual({
    code: EXIT_FAILED,
    end: ['run:end', 'failed', 'stage_error'],
    failed: [['merge#1', 'codeHost.merge: GitHub 405: Pull Request is not mergeable']],
    merged: [],
    open: ['open', null],
  });
});
