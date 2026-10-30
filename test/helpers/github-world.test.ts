// The GitHub world's two opt-in options (ADW-109, DECISIONS D13), through its injected `fetch`: `followHeads`, so a push
// to an open pull request's branch moves its head, and `checksFor`, so a head the seed never listed still has check
// runs, by how often it was read. A seed with neither answers as it always has: the head the seed read, and no checks
// for an unlisted sha.
import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitHubWorld, type GitHubWorld, type GitHubWorldSeed, WORLD_API, worldMergeSha } from './github-world';
import { withOrigin } from './origin';
import { type TempRepo, withTempRepo } from './temp-repo';

const TOKEN = 'ghp_MARKER_world_5d2c71e0';
const PREFIX = `${WORLD_API}/repos/o/r`;

/** The fields of the world's answers these cases read: whichever route was asked, the others are absent. */
interface Reply {
  number: number;
  head: { sha: string };
  total_count: number;
  check_runs: { name: string; [field: string]: unknown }[];
  state: string;
  statuses: { context: string }[];
  merged_at: string | null;
  merge_commit_sha: string | null;
  message: string;
  errors: { resource: string; code: string; message: string }[];
  documentation_url: string;
}

/** A request to the world, as the adapter makes it: the JSON it answers, parsed. */
async function ask(
  world: GitHubWorld,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Reply }> {
  const response = await world.fetch(`${PREFIX}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Reply };
}

/** Adds a commit to `branch` of the origin, cut from `main` when it is new, and gives its sha. */
function pushTo(repo: TempRepo, origin: string, branch: string, file: string): string {
  const pusher = join(repo.dir, '..', `pusher-${branch.replaceAll('/', '-')}`);
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: args[0] === 'clone' ? join(repo.dir, '..') : pusher,
      env: repo.env,
    });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  if (existsSync(pusher)) run('fetch', '--quiet', 'origin');
  else run('clone', '--quiet', origin, pusher);
  const known = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `origin/${branch}`], {
    cwd: pusher,
    env: repo.env,
  });
  run('checkout', '--quiet', '-B', branch, known.exitCode === 0 ? `origin/${branch}` : 'origin/main');
  writeFileSync(join(pusher, file), `${file}\n`);
  run('add', file);
  run('commit', '--quiet', '-m', `add ${file}`);
  run('push', '--quiet', 'origin', `${branch}:refs/heads/${branch}`);
  return run('rev-parse', 'HEAD');
}

/** A world over a fresh origin whose branch `topic` has one commit, with pull request 1 on it. */
async function withWorld<T>(
  seed: Partial<GitHubWorldSeed>,
  fn: (world: GitHubWorld, push: () => string, first: string, pushMain: (branch: string) => void) => Promise<T>,
): Promise<T> {
  return withTempRepo(async (repo) => {
    const origin = withOrigin(repo).url;
    const first = pushTo(repo, origin, 'topic', 'one.txt');
    const world = createGitHubWorld({
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      bare: origin,
      env: repo.env,
      token: TOKEN,
      pullRequests: [{ number: 1, head: 'topic' }],
      ...seed,
    });
    let pushes = 0;
    const pushMain = (branch: string) => {
      const pushed = Bun.spawnSync(['git', 'push', '--quiet', 'origin', `origin/main:refs/heads/${branch}`], {
        cwd: join(repo.dir, '..', 'pusher-topic'),
        env: repo.env,
      });
      if (pushed.exitCode !== 0) throw new Error(`git push: ${pushed.stderr.toString()}`);
    };
    return fn(world, () => pushTo(repo, origin, 'topic', `more-${++pushes}.txt`), first, pushMain);
  });
}

test('with followHeads a push to the pull request branch moves its head in GET /pulls/<n>, and the merge check follows it', async () => {
  await withWorld({ followHeads: true }, async (world, push, first) => {
    expect((await ask(world, 'GET', '/pulls/1')).json.head.sha).toBe(first);
    const second = push();
    expect(second).not.toBe(first);
    expect((await ask(world, 'GET', '/pulls/1')).json.head.sha).toBe(second);
    const stale = await ask(world, 'PUT', '/pulls/1/merge', { merge_method: 'squash', sha: first });
    expect(stale.status).toBe(409);
    const fresh = await ask(world, 'PUT', '/pulls/1/merge', { merge_method: 'squash', sha: second });
    expect(fresh.status).toBe(200);
  });
});

test('with followHeads a pull request opened through POST /pulls follows its branch too, and one that is merged keeps the head it merged at', async () => {
  await withWorld({ followHeads: true, pullRequests: [] }, async (world, push, first) => {
    const opened = await ask(world, 'POST', '/pulls', { title: 'Topic', head: 'topic', base: 'main' });
    expect(opened.json.head.sha).toBe(first);
    const second = push();
    expect((await ask(world, 'GET', `/pulls/${opened.json.number}`)).json.head.sha).toBe(second);
    await ask(world, 'PUT', `/pulls/${opened.json.number}/merge`, { merge_method: 'squash', sha: second });
    push();
    expect((await ask(world, 'GET', `/pulls/${opened.json.number}`)).json.head.sha).toBe(second);
  });
});

test('without followHeads a push leaves the head the seed read: the merge at it is still accepted', async () => {
  await withWorld({}, async (world, push, first) => {
    push();
    expect((await ask(world, 'GET', '/pulls/1')).json.head.sha).toBe(first);
    expect((await ask(world, 'PUT', '/pulls/1/merge', { merge_method: 'squash', sha: first })).status).toBe(200);
  });
});

test('a pull request seeded with a headSha keeps it under followHeads', async () => {
  await withWorld(
    { followHeads: true, pullRequests: [{ number: 1, head: 'topic', headSha: 'a'.repeat(40) }] },
    async (world, push) => {
      push();
      expect((await ask(world, 'GET', '/pulls/1')).json.head.sha).toBe('a'.repeat(40));
    },
  );
});

test('with checksFor the check-runs of a sha the seed never listed are answered by the read count, and the pull request is the one at that head', async () => {
  const seen: [number, string, number][] = [];
  await withWorld(
    {
      checksFor: (pull, sha, read) => {
        seen.push([pull.number, sha, read]);
        return {
          checkRuns: [
            {
              name: 'test',
              status: read === 1 ? 'in_progress' : 'completed',
              conclusion: read === 1 ? null : 'success',
            },
          ],
        };
      },
    },
    async (world, _push, first) => {
      const read = async () => (await ask(world, 'GET', `/commits/${first}/check-runs?per_page=100&page=1`)).json;
      expect((await read()).check_runs).toEqual([{ name: 'test', status: 'in_progress', conclusion: null }]);
      expect((await read()).check_runs).toEqual([{ name: 'test', status: 'completed', conclusion: 'success' }]);
      expect((await read()).total_count).toBe(1);
      expect(seen).toEqual([
        [1, first, 1],
        [1, first, 2],
        [1, first, 3],
      ]);
      // A sha no pull request is at has no checks, and the callback isn't asked.
      const none = (await ask(world, 'GET', `/commits/${'b'.repeat(40)}/check-runs`)).json;
      expect({ total: none.total_count, runs: none.check_runs }).toEqual({ total: 0, runs: [] });
      expect(seen).toHaveLength(3);
    },
  );
});

test('with checksFor a status read is answered by the same callback without counting as a check-runs read', async () => {
  const seen: number[] = [];
  await withWorld(
    {
      checksFor: (_pull, _sha, read) => {
        seen.push(read);
        return { statuses: [{ context: 'ci', state: 'success' }] };
      },
    },
    async (world, _push, first) => {
      const status = (await ask(world, 'GET', `/commits/${first}/status`)).json;
      expect({
        state: status.state,
        contexts: status.statuses.map((each) => each.context),
      }).toEqual({ state: 'success', contexts: ['ci'] });
      expect(seen).toEqual([0]);
    },
  );
});

test('a sha the seed lists keeps its checks, whatever checksFor would say', async () => {
  await withWorld(
    {
      pullRequests: [
        { number: 1, head: 'topic', checkRuns: [{ name: 'lint', status: 'completed', conclusion: 'success' }] },
      ],
      checksFor: () => ({ checkRuns: [{ name: 'test', status: 'completed', conclusion: 'failure' }] }),
    },
    async (world, _push, first) => {
      expect(
        (await ask(world, 'GET', `/commits/${first}/check-runs`)).json.check_runs.map(
          (each: { name: string }) => each.name,
        ),
      ).toEqual(['lint']);
    },
  );
});

test('without checksFor the check-runs of an unlisted sha are empty, as they were', async () => {
  await withWorld({}, async (world, _push, first) => {
    const none = (await ask(world, 'GET', `/commits/${first}/check-runs`)).json;
    expect({ total: none.total_count, runs: none.check_runs }).toEqual({ total: 0, runs: [] });
  });
});

test('an injected answer with applied lets the world handle the request first, and still answers the canned response', async () => {
  await withWorld({}, async (world, _push, first) => {
    world.inject('PUT /pulls/1/merge', { status: 502, body: { message: 'Bad Gateway' }, applied: true });
    const lost = await ask(world, 'PUT', '/pulls/1/merge', { merge_method: 'squash', sha: first });
    expect(lost.status).toBe(502);
    const read = (await ask(world, 'GET', '/pulls/1')).json;
    expect({ mergedAt: read.merged_at !== null, sha: read.merge_commit_sha }).toEqual({
      mergedAt: true,
      sha: worldMergeSha(1, first),
    });
  });
});

test('an injected answer without applied leaves the pull request unmerged', async () => {
  await withWorld({}, async (world, _push, first) => {
    world.inject('PUT /pulls/1/merge', { status: 502, body: { message: 'Bad Gateway' } });
    expect((await ask(world, 'PUT', '/pulls/1/merge', { merge_method: 'squash', sha: first })).status).toBe(502);
    const read = (await ask(world, 'GET', '/pulls/1')).json;
    expect({ mergedAt: read.merged_at, sha: read.merge_commit_sha }).toEqual({ mergedAt: null, sha: null });
  });
});

const NO_COMMITS = (head: string): Partial<Reply> => ({
  message: 'Validation Failed',
  errors: [{ resource: 'PullRequest', code: 'custom', message: `No commits between main and ${head}` }],
  documentation_url: 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request',
});

test("POST /pulls with a head that has no commits beyond its base answers GitHub's 422 and opens nothing", async () => {
  await withWorld({ pullRequests: [] }, async (world, _push, _first, pushMain) => {
    const onMain = await ask(world, 'POST', '/pulls', { title: 'Main', head: 'main', base: 'main' });
    expect<unknown>([onMain.status, onMain.json]).toEqual([422, NO_COMMITS('main')]);
    pushMain('empty');
    const empty = await ask(world, 'POST', '/pulls', { title: 'Empty', head: 'empty', base: 'main' });
    expect<unknown>([empty.status, empty.json]).toEqual([422, NO_COMMITS('empty')]);
    expect(world.pullRequests).toEqual([]);
    const topic = await ask(world, 'POST', '/pulls', { title: 'Topic', head: 'topic', base: 'main' });
    expect([topic.status, topic.json.number]).toEqual([201, 1]);
  });
});
