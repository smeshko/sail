// The github definition: `codeHost: { use: github, repository, remote, draft }` in `project.yaml`, resolved through
// the adapter registry from BUILTINS. Its token comes from SAIL_GITHUB_TOKEN or else GITHUB_TOKEN, checked at preflight
// (DECISIONS D7), its endpoint from SAIL_GITHUB_API_URL (D6), and its repository from the option or else the remote's
// github.com URL (D8). Each case resolves against a scripted GitHub of its own, served on 127.0.0.1.
import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { githubRepositoryOf } from '../../../src/adapters/code-host/github';
import { BUILTINS } from '../../../src/adapters/index';
import { resolveAdapters } from '../../../src/engine/adapters';
import type { AdapterConfig, ProjectConfig } from '../../../src/engine/config';
import type { CodeHost } from '../../../src/ports/code-host';
import { createGitHubWorld, type GitHubWorld } from '../../helpers/github-world';
import { type TempRepo, withTempRepo } from '../../helpers/temp-repo';

const SAIL_TOKEN = 'ghp_MARKER_sail_token_6d02';
const GITHUB_TOKEN = 'ghp_MARKER_github_token_91fa';

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ("githubRepositoryOf reads github.com's https, scp-like and ssh remotes, with or without .git, and nothing else", () => {
  const urls = [
    'https://github.com/octo/hello.git',
    'https://github.com/octo/hello',
    'https://github.com/octo/hello/',
    'https://user:secret@github.com/octo/hello.git',
    'git@github.com:octo/hello.git',
    'git@github.com:octo/hello',
    'ssh://git@github.com/octo/hello.git',
    'ssh://git@github.com:22/octo/hello',
    'https://gitlab.com/octo/hello.git',
    'https://github.com/octo',
    '/tmp/origin.git',
    'https://github.com.evil/octo/hello',
  ];
  const hello = { owner: 'octo', repo: 'hello' };
  expect(urls.map(githubRepositoryOf)).toEqual([hello, hello, hello, hello, hello, hello, hello, hello, undefined, undefined, undefined, undefined]);
});

/** The repository's config: the fakes, but the code host's entry. */
const configOf = (codeHost: AdapterConfig): ProjectConfig => ({
  name: 'test',
  sail: '>=0.0.0',
  adapters: { ticketSource: { use: 'fake' }, codeHost, harness: { use: 'fake' }, workspace: { use: 'fake' } },
  models: {},
  budgets: {},
});

/** Resolves the code host alone, from BUILTINS, for `.sail/` in the repository, in `env`. */
async function resolve(repo: TempRepo, codeHost: AdapterConfig, env: Record<string, string>) {
  const sailDir = join(repo.dir, '.sail');
  mkdirSync(sailDir, { recursive: true });
  const resolved = await resolveAdapters({
    sailDir,
    config: configOf(codeHost),
    builtins: BUILTINS,
    env: { HOME: repo.home, PATH: process.env.PATH ?? '', ...env },
    ports: ['codeHost'],
  });
  return 'issues' in resolved
    ? { issues: resolved.issues.map((issue) => `${issue.path} ${issue.message}`) }
    : { host: resolved.ports.codeHost as CodeHost, entry: resolved.entries.codeHost };
}

/** A world for `o/r` that takes `token`, served for the test, and stopped after. */
async function withWorld<T>(repo: TempRepo, token: string, fn: (world: GitHubWorld, url: string) => Promise<T>) {
  // The branches are the repository's own: these cases push nothing.
  const world = createGitHubWorld({
    owner: 'o',
    repo: 'r',
    defaultBranch: 'main',
    bare: repo.dir,
    env: repo.env,
    token,
    pullRequests: [{ number: 7, head: 'main', base: 'main' }],
  });
  const served = world.serve();
  try {
    return await fn(world, served.url);
  } finally {
    served.stop();
  }
}

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('github resolves with GITHUB_TOKEN alone or SAIL_GITHUB_TOKEN alone, and with both it sends SAIL_GITHUB_TOKEN, to SAIL_GITHUB_API_URL', async () => {
  await withTempRepo(async (repo) => {
    const read = async (token: string, env: Record<string, string>) =>
      withWorld(repo, token, async (world, url) => {
        const resolved = await resolve(repo, { use: 'github', repository: 'o/r' }, { ...env, SAIL_GITHUB_API_URL: url });
        if (!('host' in resolved)) return resolved;
        const pr = await resolved.host.getPullRequest(7);
        return { name: resolved.host.name, number: pr.number, matched: world.requests.map((request) => request.tokenMatched) };
      });
    const answered = { name: 'github', number: 7, matched: [true] };
    expect([
      await read(GITHUB_TOKEN, { GITHUB_TOKEN }),
      await read(SAIL_TOKEN, { SAIL_GITHUB_TOKEN: SAIL_TOKEN }),
      await read(SAIL_TOKEN, { SAIL_GITHUB_TOKEN: SAIL_TOKEN, GITHUB_TOKEN }),
    ]).toEqual([answered, answered, answered]);
  });
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('without a token, or with both variables empty, github is refused at preflight, naming both variables', async () => {
  await withTempRepo(async (repo) => {
    const refusal = '/adapters/codeHost needs one of SAIL_GITHUB_TOKEN, GITHUB_TOKEN, none of which is set';
    expect([
      await resolve(repo, { use: 'github', repository: 'o/r' }, {}),
      await resolve(repo, { use: 'github', repository: 'o/r' }, { SAIL_GITHUB_TOKEN: '', GITHUB_TOKEN: '' }),
    ]).toEqual([{ issues: [refusal] }, { issues: [refusal] }]);
  });
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('an option github cannot read is refused, naming the option: a draft that is no boolean, an unknown option, a malformed repository', async () => {
  await withTempRepo(async (repo) => {
    const env = { GITHUB_TOKEN };
    const refused = await Promise.all([
      resolve(repo, { use: 'github', repository: 'o/r', draft: 'yes' }, env),
      resolve(repo, { use: 'github', repository: 'o/r', apiUrl: 'https://example.com' }, env),
      resolve(repo, { use: 'github', repository: 'o' }, env),
    ]);
    expect(refused.map((result) => ('issues' in result ? result.issues : result))).toEqual([
      [expect.stringContaining('/adapters/codeHost github could not be created: github codeHost: option draft: ')],
      [expect.stringContaining('/adapters/codeHost github could not be created: github codeHost: option apiUrl: ')],
      ['/adapters/codeHost github could not be created: github codeHost: option repository: must be owner/name, such as octo/hello'],
    ]);
  });
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ("without the repository option, a github.com origin names the repository, and any other origin is refused, naming the option and none of the URL's credentials", async () => {
  await withTempRepo(async (repo) => {
    const env = { GITHUB_TOKEN };
    repo.git('remote', 'add', 'origin', '/tmp/origin.git');
    repo.git('remote', 'add', 'hub', 'https://user:secret@github.com/o/r.git');
    repo.git('remote', 'add', 'lab', 'https://user:secret@gitlab.com/o/r.git');
    const local = await resolve(repo, { use: 'github' }, env);
    const lab = await resolve(repo, { use: 'github', remote: 'lab' }, env);
    const hub = await withWorld(repo, GITHUB_TOKEN, async (world, url) => {
      const resolved = await resolve(repo, { use: 'github', remote: 'hub' }, { ...env, SAIL_GITHUB_API_URL: url });
      if ('host' in resolved) await resolved.host.getPullRequest(7);
      return world.routes();
    });
    expect({ local, lab, hub }).toEqual({
      local: {
        issues: [
          '/adapters/codeHost github could not be created: github codeHost: origin is not a github.com remote (/tmp/origin.git): set the repository option, such as repository: owner/name',
        ],
      },
      lab: {
        issues: [
          '/adapters/codeHost github could not be created: github codeHost: lab is not a github.com remote (https://gitlab.com/o/r.git): set the repository option, such as repository: owner/name',
        ],
      },
      hub: ['GET /repos/o/r/pulls/7'],
    });
  });
});
