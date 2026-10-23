// What the chain's tests share (ADW-109): the chain fixture's `.sail/` copied into a temporary repository, and the worlds
// its runs talk to. The fixture is `test/fixtures/chain/.sail/`: a test `ticket-to-pr` and a test `pr-to-main`, on the
// real Linear, GitHub and git-worktree adapters and the fake harness.
//
// `withChain()` builds one clone on every real adapter but the harness: `.sail/` uncommitted and `.sail-runs/` ignored, a
// bare origin the GitHub world reads its branches from, the scripted Linear and GitHub served on 127.0.0.1, and the
// pull requests the test asks for, each on a branch of its own cut from `main`. Every pull request is behind `main`:
// `main` moves once after the branches are cut, so a run has to merge it in. The GitHub world follows pushes
// (`followHeads`) and answers checks for any head (`checksFor`): the check `test` is pending on its first read of a head,
// then failed while the pull request carries `ci-red` and passed otherwise, as the sandbox's CI behaves. A pull request
// listed in `silent` never registers `test`, so its checks read as an empty list.
//
// The levers a test pulls are options, not edits to the fixture: a pull request's labels, `conflict`, `testsFail`, a
// `silent` check, an edit of the copied `harness.json`, and `removeLabelAtAllStart()`. Every `sail` is a process of its own,
// spawned with the clone's env: its script steps' `sail port` reach the worlds over HTTP. Both keys are markers.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatIssue, validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import type { SailEvent } from '../../src/events/types';
import {
  createGitHubWorld,
  type GitHubWorld,
  type WorldChecks,
  type WorldPull,
  type WorldSeedPull,
} from './github-world';
import { createLinearWorld, DEFAULT_STATES, type LinearWorld, type WorldTicket } from './linear-world';
import { type Origin, withOrigin } from './origin';
import { sail as runSail, until } from './sail-process';
import { type TempRepo, withTempRepo } from './temp-repo';

export const CHAIN_SAIL = join(import.meta.dir, '..', 'fixtures', 'chain', '.sail');

export const LINEAR_KEY = 'lin_api_MARKER_chain_3b71e9d0';
export const GITHUB_TOKEN = 'ghp_MARKER_chain_a40c8e15f7';

/** The directory a run leaves its runs in, under the clone. */
export const RUNS = '.sail-runs';

/** Copies the chain fixture's `.sail/` into `repoDir`, and returns the copy. */
export function copyChain(repoDir: string): string {
  const copy = join(repoDir, '.sail');
  cpSync(CHAIN_SAIL, copy, { recursive: true });
  return copy;
}

/** One pull request the world holds, on a branch cut from `main` before `main` moved. */
export interface ChainPull {
  readonly number: number;
  /** Its head branch: `sail/ADW-1-<slug>` for one with a ticket. */
  readonly branch: string;
  /** Its labels: `sail`, the designation, unless given. */
  readonly labels?: readonly string[];
  /** The ticket its body's marker names, when it has one. */
  readonly ticket?: string;
  /** The files its branch adds, by path. A commit of `chain/<branch>.md` unless given. */
  readonly files?: Readonly<Record<string, string>>;
  /** Its branch and `main` both change `conflict.txt`, so merging `main` in conflicts. */
  readonly conflict?: boolean;
  /** Its branch holds `chain/tests-fail`, so the `tests` stage fails on every pass. */
  readonly testsFail?: boolean;
}

export interface ChainOptions {
  readonly pulls?: readonly ChainPull[];
  /** The Linear tickets: ADW-1 designated Todo, unless given. */
  readonly tickets?: readonly WorldTicket[];
  /** The pull requests whose check `test` never registers. */
  readonly silent?: readonly number[];
  /** Edits the copy's `fake/harness.json` before any run reads it. */
  readonly harness?: (answers: Record<string, Record<string, unknown>[]>) => void;
  /** The copy of the fixture's `.sail/`, after `harness` has changed it. */
  readonly prepare?: (sail: string) => void;
  /** Names of files a call leaves in its directory that `observe()` reads, by `<call key>/<name>`. */
  readonly capture?: readonly string[];
  /** Extra environment for every `sail` process: what the watcher's runs and their script steps inherit. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface Chain {
  readonly repo: TempRepo;
  readonly origin: Origin;
  readonly linear: LinearWorld;
  readonly github: GitHubWorld;
  /** The copy of the fixture, `<clone>/.sail`. */
  readonly sail: string;
  /** The environment of every `sail` process. */
  readonly env: Record<string, string>;
  /** `<clone>/.sail-runs`. */
  readonly runs: string;
  /** The clone's HEAD and status before anything ran. */
  readonly before: { head: string; status: string };
  /** The world's pull request `number`. */
  pull(number: number): WorldPull;
  /** `sail <argv>` in the clone, run to its end. */
  run(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** The run directories, oldest name first. */
  runDirs(): string[];
  /** The events of the run in `dir`. */
  eventsOf(dir: string): SailEvent[];
}

/** The ticket marker `github-pull` reads out of a pull request's body. */
const marker = (ticket: string) => `Opened for ${ticket}.\n\n<!-- sail:ticket ${ticket} -->`;

/** The check runs the world answers for `pull` at a head it has read `read` times: D13's `test`. */
function checkRunsOf(pull: WorldPull, read: number): WorldChecks {
  const check = (status: string, conclusion?: string) => ({
    checkRuns: [{ name: 'test', status, ...(conclusion === undefined ? {} : { conclusion }) }],
  });
  if (read <= 1) return check('in_progress');
  return pull.labels.includes('ci-red') ? check('completed', 'failure') : check('completed', 'success');
}

/** Runs git in `cwd` with `env`, and throws with its stderr when it fails. */
function git(cwd: string, env: Readonly<Record<string, string>>, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env, stdin: 'ignore' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

/**
 * A clone of the repository on every real adapter but the harness, with the chain fixture in it and `options`' pull
 * requests behind `main`. Calls `fn` with it, and stops the worlds and removes the clone after.
 */
export async function withChain<T>(options: ChainOptions, fn: (chain: Chain) => Promise<T>): Promise<T> {
  return withTempRepo(async (repo) => {
    writeFileSync(join(repo.dir, '.gitignore'), `${RUNS}/\n`);
    repo.git('add', '.gitignore');
    repo.git('commit', '-q', '-m', 'ignore the runs');
    const origin = withOrigin(repo);
    const pulls = options.pulls ?? [];
    if (pulls.some((pull) => pull.conflict)) origin.push('conflict.txt', 'one line\n');

    // Each branch is cut from main as it is now, in a clone of its own that pushes to the bare origin.
    const pusher = join(dirname(repo.dir), 'chain-pusher');
    git(dirname(repo.dir), repo.env, 'clone', '--quiet', origin.url, pusher);
    for (const pull of pulls) {
      git(pusher, repo.env, 'checkout', '--quiet', '-B', pull.branch, 'origin/main');
      const files: Record<string, string> = {
        ...(pull.files ?? { [`chain/${pull.number}.md`]: `pull request ${pull.number}\n` }),
        ...(pull.conflict ? { 'conflict.txt': 'the branch changes this line\n' } : {}),
        ...(pull.testsFail ? { 'chain/tests-fail': 'fail\n' } : {}),
      };
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(pusher, path)), { recursive: true });
        writeFileSync(join(pusher, path), text);
        git(pusher, repo.env, 'add', path);
      }
      git(pusher, repo.env, 'commit', '--quiet', '-m', `pull request ${pull.number}`);
      git(pusher, repo.env, 'push', '--quiet', 'origin', `${pull.branch}:refs/heads/${pull.branch}`);
    }
    // main moves after the branches were cut, and after the clone last fetched.
    origin.push('main-moved.txt');
    if (pulls.some((pull) => pull.conflict)) origin.push('conflict.txt', 'main changes this line\n');

    const sail = copyChain(repo.dir);
    if (options.harness !== undefined) {
      const path = join(sail, 'fake', 'harness.json');
      const answers = JSON.parse(readFileSync(path, 'utf8'));
      options.harness(answers);
      writeFileSync(path, `${JSON.stringify(answers, null, 2)}\n`);
    }
    options.prepare?.(sail);

    const silent = new Set(options.silent ?? []);
    const github = createGitHubWorld({
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      bare: origin.url,
      env: repo.env,
      token: GITHUB_TOKEN,
      followHeads: true,
      checksFor: (pull, _sha, read) => (silent.has(pull.number) ? undefined : checkRunsOf(pull, read)),
      pullRequests: pulls.map(
        (pull): WorldSeedPull => ({
          number: pull.number,
          head: pull.branch,
          title: `Pull request ${pull.number}`,
          body: pull.ticket === undefined ? 'No ticket.' : marker(pull.ticket),
          labels: pull.labels ?? ['sail'],
        }),
      ),
    });
    const linear = createLinearWorld({
      team: { key: 'ADW', states: DEFAULT_STATES },
      apiKey: LINEAR_KEY,
      tickets: options.tickets ?? [
        { number: 1, title: 'Add a chain', description: 'Open a pull request.', state: 'Todo', labels: ['sail'] },
      ],
    });
    const servedGitHub = github.serve();
    const servedLinear = linear.serve();
    try {
      const { SAIL_GITHUB_TOKEN: _sail, GITHUB_TOKEN: _github, ...base } = repo.env;
      const env = {
        ...base,
        GITHUB_TOKEN,
        SAIL_GITHUB_API_URL: servedGitHub.url,
        LINEAR_API_KEY: LINEAR_KEY,
        SAIL_LINEAR_API_URL: servedLinear.url,
        ...options.env,
      };
      const runs = join(repo.dir, RUNS);
      const before = { head: repo.git('rev-parse', 'HEAD'), status: repo.git('status', '--porcelain') };
      return await fn({
        repo,
        origin,
        linear,
        github,
        sail,
        env,
        runs,
        before,
        pull(number) {
          const found = github.pullRequests.find((pull) => pull.number === number);
          if (found === undefined) throw new Error(`the world holds no pull request ${number}`);
          return found;
        },
        run: (argv) => runSail(repo.dir, env, argv),
        runDirs: () =>
          existsSync(runs)
            ? readdirSync(runs)
                .filter((name) => existsSync(join(runs, name, 'run.json')))
                .sort()
            : [],
        eventsOf: (dir) => readEvents(join(runs, dir)),
      });
    } finally {
      servedGitHub.stop();
      servedLinear.stop();
    }
  });
}

/**
 * Removes `label` from the world's pull request `number` as soon as the group of reviewers has started in any run: the
 * first `all:start` any run directory holds. Gives what happened: the label was removed, or the wait ran out.
 */
export async function removeLabelAtAllStart(chain: Chain, number: number, label: string): Promise<string> {
  const started = () =>
    chain.runDirs().some((dir) => {
      const path = join(chain.runs, dir, 'events.ndjson');
      return existsSync(path) && readFileSync(path, 'utf8').includes('"type":"all:start"');
    });
  const said = await until('the reviewers started', started);
  if (said !== 'the reviewers started') return said;
  const pull = chain.pull(number);
  pull.labels = pull.labels.filter((each) => each !== label);
  return `removed ${label}`;
}

/** The requests to `route` (`<METHOD> <path>` under /repos/o/r), each as its body, or null when it had none. */
export const bodiesOf = (world: GitHubWorld, route: string): unknown[] => {
  const [method, path] = route.split(' ');
  return world.requests
    .filter((request) => `${request.method} ${request.path.split('?')[0]}` === `${method} /repos/o/r${path}`)
    .map((request) => request.body ?? null);
};

/** The event types of `events`, in order, for the ones that match `pattern`. */
export const typesOf = (events: readonly SailEvent[], pattern: RegExp): string[] =>
  events.map((event) => event.type).filter((type) => pattern.test(type));

/** What a call left in its `result.json` that a test reads. */
export interface CallResult {
  readonly outcome: string;
  readonly output?: unknown;
}

/** What one by-hand run of the chain left, copied out before the clone and the worlds went away. */
export interface Observed {
  readonly code: number;
  readonly stderr: string;
  /** The run's directory name: a by-hand run makes exactly one. */
  readonly dir: string;
  readonly events: SailEvent[];
  /** The run's own end: its `run:end`. */
  readonly end: { status?: string; stopReason?: string; message?: string; result?: unknown };
  /** Each call's result, by key (`checks#1`). */
  readonly results: Record<string, CallResult>;
  /** The files `capture` named that calls left, by `<call key>/<name>`. */
  readonly captured: Record<string, string>;
  /** The feedback each `fix` call was given, by key (`fix#1`). */
  readonly feedback: Record<string, unknown>;
  /** What the GitHub world was asked, `<METHOD> <path>` in order, and the requests themselves. */
  readonly routes: string[];
  readonly requests: GitHubWorld['requests'];
  /** The world's pull requests when the run ended. */
  readonly pulls: WorldPull[];
  /** The Linear world's tickets when the run ended, by number. */
  readonly tickets: Record<number, WorldTicket>;
  /** Every way the run directory breaks its schemas. */
  readonly issues: string[];
  /** The leases HOME holds, the clone's worktrees, and the clone's HEAD and status, once the run ended. */
  readonly leases: string[];
  readonly worktrees: string[];
  readonly after: { head: string; status: string };
  readonly before: { head: string; status: string };
  readonly clone: string;
}

/** The directory of `stage`'s call `call` in the run directory `dir`: `<NN>-<stage>/call-<call>`. */
function callDir(dir: string, stage: string, call: number): string | undefined {
  const folder = readdirSync(dir).find((name) => new RegExp(`^\\d+-${stage}$`).test(name));
  return folder === undefined ? undefined : join(dir, folder, `call-${call}`);
}

/**
 * `sail <argv>` once in a chain of `options`, with `during` running beside it (it may change the worlds), and what it left.
 * A by-hand run makes exactly one run directory.
 */
export async function observe(
  options: ChainOptions,
  argv: readonly string[],
  during?: (chain: Chain) => Promise<unknown>,
): Promise<Observed> {
  return withChain(options, async (chain) => {
    const [ran] = await Promise.all([chain.run(argv), during?.(chain)]);
    const [name = ''] = chain.runDirs();
    const dir = join(chain.runs, name);
    const events = existsSync(dir) ? chain.eventsOf(name) : [];
    const results: Record<string, CallResult> = {};
    const feedback: Record<string, unknown> = {};
    const captured: Record<string, string> = {};
    for (const event of events) {
      if (event.type !== 'stage:end') continue;
      const { key, stage, call } = event as unknown as { key: string; stage: string; call: number };
      const where = callDir(dir, stage, call);
      if (where === undefined) continue;
      results[key] = JSON.parse(readFileSync(join(where, 'result.json'), 'utf8'));
      const given = join(where, 'in', 'feedback.json');
      for (const name of options.capture ?? []) {
        if (existsSync(join(where, name))) captured[`${key}/${name}`] = readFileSync(join(where, name), 'utf8');
      }
      if (stage === 'fix' && existsSync(given)) feedback[key] = JSON.parse(readFileSync(given, 'utf8'));
    }
    const leases = join(chain.repo.home, '.sail', 'leases');
    const end = events.find((event) => event.type === 'run:end') as Observed['end'] | undefined;
    const numbers = (options.tickets ?? [{ number: 1 }]).map((ticket) => ticket.number);
    return {
      code: ran.code,
      stderr: ran.stderr,
      dir: name,
      events,
      end: end ?? {},
      results,
      captured,
      feedback,
      routes: chain.github.routes(),
      requests: [...chain.github.requests],
      pulls: structuredClone(chain.github.pullRequests),
      tickets: Object.fromEntries(numbers.map((number) => [number, structuredClone(chain.linear.ticket(number))])),
      issues: existsSync(dir) ? validateRunDir(dir).issues.map(formatIssue) : ['no run directory'],
      leases: existsSync(leases) ? readdirSync(leases) : [],
      worktrees: chain.repo
        .git('worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length)),
      after: { head: chain.repo.git('rev-parse', 'HEAD'), status: chain.repo.git('status', '--porcelain') },
      before: chain.before,
      clone: chain.repo.dir,
    };
  });
}
