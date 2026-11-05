// The fixture's ticket-to-pr on `codeHost: { use: github, repository: o/r }`, end to end from the CLI, offline: the
// workspace on git-worktree with a local bare origin, the scripted GitHub served on 127.0.0.1 through
// SAIL_GITHUB_API_URL on that origin, and the ticket source and the harness fake. The token is a marker in GITHUB_TOKEN,
// so a case can show that it reached GitHub and nothing else. Every `sail` is a process of its own, spawned with the
// repository's env: a script step's `sail port codehost` inherits that process's environment.
//
// One run per repository: the cases that read what a completed run left share one, and the draft, the crash and the
// preflight each have a repository of their own.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { readJournal } from '../../src/engine/journal';
import { readEvents } from '../../src/events/consumers/ndjson';
import type { SailEvent } from '../../src/events/types';
import { fakeCredentialTools } from '../helpers/fake-credentials';
import { copyFixture, edit, holdAfterOpen, killWhenHeld } from '../helpers/fixture';
import { createGitHubWorld, type GitHubWorld, type WorldSeedPull } from '../helpers/github-world';
import { withOrigin } from '../helpers/origin';
import { writePrWorkflow } from '../helpers/pr-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');
const TOKEN = 'ghp_MARKER_run_e5a0c93b71';
const BRANCH = 'sail/FAKE-1-add-a-shout-flag-to-the-greet-command';
const CODE_HOST = 'codeHost: { use: fake, seed: ./fake/prs.json }';

interface Clone {
  repo: TempRepo;
  world: GitHubWorld;
  /** The bare origin's path. */
  origin: string;
  /** The environment every `sail` runs in: the marker token, the world's URL, none of the shell's own tokens. */
  env: Record<string, string>;
}

/**
 * A clone of the fixture repository on github: `.sail/` uncommitted, `.sail-runs/` ignored, a bare origin that the
 * world reads its branches from, and the workspace on git-worktree. `codeHost` is the entry's options after `use`.
 */
async function withClone<T>(
  codeHost: string,
  fn: (clone: Clone) => Promise<T>,
  env: { token?: boolean; pulls?: readonly WorldSeedPull[] } = {},
) {
  return withTempRepo(async (repo) => {
    writeFileSync(join(repo.dir, '.gitignore'), '.sail-runs/\n');
    repo.git('add', '.gitignore');
    repo.git('commit', '-q', '-m', 'ignore the runs');
    const origin = withOrigin(repo).url;
    const sail = copyFixture(repo.dir);
    edit(sail, 'project.yaml', 'workspace: { use: fake }', 'workspace: { use: git-worktree }');
    edit(sail, 'project.yaml', CODE_HOST, `codeHost: { use: github, ${codeHost} }`);
    const world = createGitHubWorld({
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      bare: origin,
      env: repo.env,
      token: TOKEN,
      ...(env.pulls === undefined ? {} : { pullRequests: env.pulls }),
    });
    const served = world.serve();
    try {
      const { SAIL_GITHUB_TOKEN: _sail, GITHUB_TOKEN: _github, ...base } = repo.env;
      const run = { ...base, SAIL_GITHUB_API_URL: served.url, ...(env.token === false ? {} : { GITHUB_TOKEN: TOKEN }) };
      return await fn({ repo, world, origin, env: run });
    } finally {
      served.stop();
    }
  });
}

/** `sail <argv>` in its own process in the clone, run to its end, in `env`. */
async function sail(clone: Clone, argv: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, MAIN, ...argv], {
    cwd: clone.repo.dir,
    env: { ...clone.env, ...env },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

/** The clone's runs, by id. */
const runIds = (repo: TempRepo): string[] =>
  existsSync(join(repo.dir, '.sail-runs'))
    ? readdirSync(join(repo.dir, '.sail-runs'))
        .filter((name) => name !== 'fake')
        .sort()
    : [];

const json = (...path: string[]) => JSON.parse(readFileSync(join(...path), 'utf8'));

/** The origin's sha for the run's branch, or '' when it has none. */
const originHead = (clone: Clone): string =>
  Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`], {
    cwd: clone.origin,
    env: clone.repo.env,
  })
    .stdout.toString()
    .trim();

/** Every file under `dir` that holds `needle`, read as bytes, by its path under `dir`. */
function holding(dir: string, needle: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((path) => {
    const full = join(dir, path);
    return statSync(full).isFile() && readFileSync(full).includes(needle);
  });
}

/** Where the marker token is found after a run: the run directories, the clone's git config and logs, and HOME. */
const markerIn = (clone: Clone) => ({
  runs: holding(join(clone.repo.dir, '.sail-runs'), TOKEN),
  config: readFileSync(join(clone.repo.dir, '.git', 'config'), 'utf8').includes(TOKEN),
  logs: holding(join(clone.repo.dir, '.git', 'logs'), TOKEN),
  home: holding(clone.repo.home, TOKEN),
});
const NOWHERE = { runs: [], config: false, logs: [], home: [] };

interface Ran extends Clone {
  code: number;
  stderr: string;
  dir: string;
  events: SailEvent[];
}

let release = (): void => {};
let shared: Promise<Ran> | undefined;

/** `sail FAKE-1` in a clone on github, run once and kept until the file's last case. */
function githubRun(): Promise<Ran> {
  shared ??= new Promise<Ran>((resolve, reject) => {
    withClone('repository: o/r', async (clone) => {
      const ran = await sail(clone, ['FAKE-1']);
      const [runId = ''] = runIds(clone.repo);
      const dir = join(clone.repo.dir, '.sail-runs', runId);
      resolve({ ...clone, ...ran, dir, events: runId === '' ? [] : readEvents(dir) });
      await new Promise<void>((done) => {
        release = done;
      });
    }).catch(reject);
  });
  return shared;
}
afterAll(() => release());

/** The shared run, which must have completed. */
async function completed(): Promise<Ran> {
  const ran = await githubRun();
  expect([ran.code, ran.stderr, existsSync(ran.dir) ? readFileSync(join(ran.dir, 'STATUS'), 'utf8') : '']).toEqual([
    EXIT_OK,
    '',
    'completed\n',
  ]);
  return ran;
}

test("sail FAKE-1 on github pushes the run's branch to the origin and opens one labelled pull request into main that names and links the ticket, and open's output is GitHub's number and URL", async () => {
  const run = await completed();
  const pushed = run.events.find((event) => event.type === 'codehost:pushed');
  const headSha = pushed?.type === 'codehost:pushed' ? pushed.headSha : 'none';
  const [pr] = run.world.pullRequests;
  expect({
    origin: originHead(run),
    commitsBeyondMain: run.repo.git('-C', run.origin, 'rev-list', '--count', `main..${BRANCH}`),
    pulls: run.world.pullRequests.map((each) => [each.head, each.base, each.labels, each.draft, each.headSha]),
    title: pr?.title.includes('FAKE-1'),
    links: pr?.body.includes('Ticket: [FAKE-1](fake://tickets/FAKE-1)'),
    marker: pr?.body.endsWith('\n\n<!-- sail:ticket FAKE-1 -->'),
    output: json(run.dir, '05-publish', 'call-1', 'steps', '2-open', 'result.json').output,
  }).toEqual({
    origin: headSha,
    commitsBeyondMain: '1',
    pulls: [[BRANCH, 'main', ['sail'], false, headSha]],
    title: true,
    links: true,
    marker: true,
    output: { number: 1, url: 'https://github.com/o/r/pull/1', draft: false },
  });
}, 60_000);

test('the events hold codehost:pushed, codehost:pr_opened and codehost:labelled under the key publish#1/open, and nothing else of the code host', async () => {
  const run = await completed();
  const hosted = run.events.filter((event) => event.type.startsWith('codehost:'));
  expect(hosted.map((event) => [event.type, 'key' in event ? event.key : undefined])).toEqual([
    ['codehost:pushed', 'publish#1/open'],
    ['codehost:pr_opened', 'publish#1/open'],
    ['codehost:labelled', 'publish#1/open'],
  ]);
}, 60_000);

test("after the run the marker token is in no run file, nor the clone's git config and logs, nor HOME, though GitHub got it on every request", async () => {
  const run = await completed();
  expect({
    found: markerIn(run),
    requests: run.world.requests.length > 0,
    matched: run.world.requests.every((request) => request.tokenMatched),
  }).toEqual({ found: NOWHERE, requests: true, matched: true });
}, 60_000);

test("with draft: true in the code host's options, the pull request opens as a draft, and open's output says so", async () => {
  await withClone('repository: o/r, draft: true', async (clone) => {
    const ran = await sail(clone, ['FAKE-1']);
    const [runId = ''] = runIds(clone.repo);
    expect({
      code: ran.code,
      drafts: clone.world.pullRequests.map((pr) => pr.draft),
      output:
        runId === ''
          ? null
          : json(clone.repo.dir, '.sail-runs', runId, '05-publish', 'call-1', 'steps', '2-open', 'result.json').output,
    }).toEqual({
      code: EXIT_OK,
      drafts: [true],
      output: { number: 1, url: 'https://github.com/o/r/pull/1', draft: true },
    });
  });
}, 60_000);

test('a run killed after open-pull-request answered resumes to completed with the same pull request: GitHub got one create and holds one pull request from the branch, and the marker is nowhere', async () => {
  await withClone('repository: o/r', async (clone) => {
    const sailDir = join(clone.repo.dir, '.sail');
    holdAfterOpen(sailDir);
    const held = join(clone.repo.home, 'open.pid');
    const child = Bun.spawn([process.execPath, MAIN, 'FAKE-1'], {
      cwd: clone.repo.dir,
      env: { ...clone.env, HOLD_AFTER_OPEN: held },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    expect(await killWhenHeld(held, child)).toBe(true);
    const [runId = ''] = runIds(clone.repo);
    const dir = join(clone.repo.dir, '.sail-runs', runId);
    const killed = markerIn(clone);
    const resumed = await sail(clone, ['resume', runId]);
    const open = readJournal(dir).entries.at(-2);
    expect({
      resumed: [resumed.code, resumed.stderr, readFileSync(join(dir, 'STATUS'), 'utf8')],
      open: [open?.key, open?.resultPath],
      output: json(dir, open?.resultPath ?? '').output,
      creates: clone.world.routes().filter((route) => route === 'POST /repos/o/r/pulls').length,
      pulls: clone.world.pullRequests.map((pr) => [pr.number, pr.head]),
      killed,
      after: markerIn(clone),
    }).toEqual({
      resumed: [EXIT_OK, '', 'completed\n'],
      open: ['publish#1/open', '05-publish/call-1/steps/2-open/try-2/result.json'],
      output: { number: 1, url: 'https://github.com/o/r/pull/1', draft: false },
      creates: 1,
      pulls: [[1, BRANCH]],
      killed: NOWHERE,
      after: NOWHERE,
    });
  });
}, 90_000);

test('without SAIL_GITHUB_TOKEN and GITHUB_TOKEN, sail FAKE-1 on github is refused at preflight with exit code 3, naming both, and no run directory', async () => {
  await withClone(
    'repository: o/r',
    async (clone) => {
      const ran = await sail(clone, ['FAKE-1']);
      expect([ran.code, ran.stderr, existsSync(join(clone.repo.dir, '.sail-runs')), clone.world.requests]).toEqual([
        EXIT_REFUSED,
        '.sail/project.yaml  /adapters/codeHost needs one of SAIL_GITHUB_TOKEN, GITHUB_TOKEN, none of which is set\n',
        false,
        [],
      ]);
    },
    { token: false },
  );
}, 60_000);

const toolDirs: string[] = [];
afterAll(() => {
  for (const dir of toolDirs) rmSync(dir, { recursive: true, force: true });
});
/** A directory for the fake tools, outside the clone's HOME: the token in a script there is not the run's to leak. */
const toolsDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sail-test-tools-'));
  toolDirs.push(dir);
  return dir;
};

/** The environment of a `sail` that reads its GitHub token from `gh`: the lookup on, and `gh` first on the PATH. */
const lookupEnv = (tools: Parameters<typeof fakeCredentialTools>[1]) => ({
  SAIL_CREDENTIAL_LOOKUP: 'on',
  PATH: fakeCredentialTools(toolsDir(), tools, process.env.PATH),
});

test('without SAIL_GITHUB_TOKEN and GITHUB_TOKEN, sail FAKE-1 on github takes the token gh auth token prints, and GitHub receives it', async () => {
  await withClone(
    'repository: o/r',
    async (clone) => {
      const ran = await sail(clone, ['FAKE-1'], lookupEnv({ ghToken: TOKEN }));
      expect([ran.code, ran.stderr, clone.world.requests.length > 0]).toEqual([EXIT_OK, '', true]);
      expect(markerIn(clone)).toEqual(NOWHERE);
    },
    { token: false },
  );
}, 90_000);

test("sail '#1' on github with no token takes the one gh auth token prints, and without gh is refused naming gh auth token", async () => {
  const pull: WorldSeedPull = {
    number: 1,
    head: 'sail/FAKE-1-x',
    labels: ['sail'],
    body: '<!-- sail:ticket FAKE-1 -->',
  };
  await withClone(
    'repository: o/r',
    async (clone) => {
      writePrWorkflow(join(clone.repo.dir, '.sail'), 'review-pr');
      clone.repo.git('checkout', '-q', '-b', pull.head, 'main');
      writeFileSync(join(clone.repo.dir, 'x.txt'), 'x\n');
      clone.repo.git('add', 'x.txt');
      clone.repo.git('commit', '-q', '-m', 'x');
      clone.repo.git('push', '-q', 'origin', pull.head);
      clone.repo.git('checkout', '-q', 'main');
      const argv = ['#1', '--workflow', 'review-pr', '--dry-run'];
      const found = await sail(clone, argv, lookupEnv({ ghToken: TOKEN }));
      expect([found.code, found.stderr]).toEqual([EXIT_OK, '']);
      expect(clone.world.requests.length).toBeGreaterThan(0);
      const before = clone.world.requests.length;
      const missing = await sail(clone, argv, lookupEnv({ noGh: true }));
      expect([missing.code, missing.stderr]).toEqual([
        EXIT_REFUSED,
        '.sail/project.yaml  /adapters/codeHost needs one of SAIL_GITHUB_TOKEN, GITHUB_TOKEN, none of which is set, and gh auth token gave none\n',
      ]);
      expect(clone.world.requests.length).toBe(before);
    },
    { token: false, pulls: [pull] },
  );
}, 90_000);

test('without a token and without gh, sail FAKE-1 on github is refused naming gh auth token', async () => {
  await withClone(
    'repository: o/r',
    async (clone) => {
      const ran = await sail(clone, ['FAKE-1'], lookupEnv({ noGh: true }));
      expect([ran.code, ran.stderr]).toEqual([
        EXIT_REFUSED,
        '.sail/project.yaml  /adapters/codeHost needs one of SAIL_GITHUB_TOKEN, GITHUB_TOKEN, none of which is set, and gh auth token gave none\n',
      ]);
    },
    { token: false },
  );
}, 60_000);
