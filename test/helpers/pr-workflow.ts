// What the pull-request tests share (DECISIONS D13): a stub pull-request workflow and the fake CodeHost's seed, written
// into a test's temp repository beside the stub from `writeStub()`. The committed fixture repository is left as it is.
//
// - `writePrWorkflow()` writes `review-pr` (or another name): the built-in `pr` intake and one agent stage, `review`,
//   that binds the input, `diff.patch` and `brief.md`. Its prompt prints the pull request's title and body, so a test can
//   find them wrapped in the rendered `prompt.md`. The fake harness answers `review#1`: its first try waits `delayMs`,
//   so a test can interrupt it, and every later try answers at once.
// - `seedPullRequests()` writes the fake CodeHost's seed from real commits: `branches.main` is the repository's main,
//   and each pull request's head is the sha its branch points at, so a workspace can start there.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { write } from './fixture';
import type { TempRepo } from './temp-repo';

export interface PrWorkflowOptions {
  /** Watched on `label` every `every`, with at most `cap` runs at once. Unwatched when left out. */
  watch?: { label: string; cap: number; every?: string };
  /** How long the review's first try waits before it answers: 0 unless given. */
  delayMs?: number;
}

/** What the review's prompt prints: the pull request's title and body, from the bound input, and the diff's path. */
export const REVIEW_PROMPT = `Review pull request #{{pr.number}}: {{pr.title}}

{{pr.body}}

The change is in {{diff}}, and the brief in {{brief}}.
`;

/** The review's answer. */
export const REVIEWED = { verdict: 'approve', findings: 0 };

/** Adds the harness's answers for `review#1` to the fake harness script, keeping any answers it holds. */
function answerReview(sail: string, delayMs: number): void {
  const path = join(sail, 'fake', 'harness.json');
  const script = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const answer = { outcome: 'done', output: REVIEWED, turns: 1, usage: { costUsd: 0.01 } };
  script['review#1'] = delayMs > 0 ? [{ ...answer, delayMs }, answer] : [answer];
  write(sail, 'fake/harness.json', `${JSON.stringify(script, null, 2)}\n`);
}

/** Writes workflow `name` into the stub `.sail/`: the `pr` intake and one agent stage that reviews the pull request. */
export function writePrWorkflow(sail: string, name = 'review-pr', options: PrWorkflowOptions = {}): void {
  const dir = `workflows/${name}`;
  const watched =
    options.watch === undefined
      ? ''
      : `, watch: { every: '${options.watch.every ?? '30s'}', label: '${options.watch.label}' }, maxConcurrentRuns: ${options.watch.cap}`;
  write(
    sail,
    `${dir}/stages/review/stage.ts`,
    `// review: reads the pull request, its diff and its brief, and answers a verdict.
import { agent, file, value, z } from 'sail';
import { PrInput } from 'sail/intakes';

export const review = agent('review', {
  prompt: './prompt.md',
  consumes: { pr: value(PrInput), diff: file('diff.patch'), brief: file('brief.md') },
  output: z.object({ verdict: z.string(), findings: z.number().int() }),
  permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
  budget: { maxTurns: 5, maxUsd: 1, maxMinutes: 5 },
});
`,
  );
  write(sail, `${dir}/stages/review/prompt.md`, REVIEW_PROMPT);
  write(
    sail,
    `${dir}/workflow.ts`,
    `// ${name}: one review of a designated pull request, from the built-in pr intake.
import { workflow } from 'sail';
import { pr } from 'sail/intakes';
import { review } from './stages/review/stage';

export default workflow('${name}', { intake: pr, version: 1${watched} }, async (run) =>
  run.stage(review, { pr: run.input, diff: run.intake.files['diff.patch'], brief: run.intake.files['brief.md'] }),
);
`,
  );
  answerReview(sail, options.delayMs ?? 0);
}

/** A pull request of the fake CodeHost's seed: open, ready and labelled `sail` into main unless it says otherwise. */
export interface SeedPullRequest {
  number: number;
  head: string;
  /** The head sha: the sha `head` points at in the repository unless given. */
  headSha?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  state?: 'open' | 'closed' | 'merged';
  labels?: string[];
  ticketKey?: string;
  fork?: boolean;
  comments?: { author: string; body: string }[];
}

/** A commit on a new branch `branch` off main, adding `file`, and its sha. The checkout is left on main. */
export function commitBranch(repo: TempRepo, branch: string, file = `${branch.replaceAll('/', '-')}.txt`): string {
  repo.git('checkout', '-q', '-b', branch, 'main');
  writeFileSync(join(repo.dir, file), `${branch}\n`);
  repo.git('add', file);
  repo.git('commit', '-q', '-m', `a change on ${branch}`);
  const sha = repo.git('rev-parse', 'HEAD');
  repo.git('checkout', '-q', 'main');
  return sha;
}

/** Writes the fake CodeHost's seed into the stub `.sail/`: main's real sha, and each pull request at its head. */
export function seedPullRequests(sail: string, repo: TempRepo, prs: readonly SeedPullRequest[]): void {
  const sha = (branch: string) => {
    const shown = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repo.dir,
      env: repo.env,
    });
    return shown.exitCode === 0 ? shown.stdout.toString().trim() : undefined;
  };
  const branches: Record<string, string> = { main: repo.git('rev-parse', 'main') };
  const pullRequests = prs.map((pr) => {
    const headSha = pr.headSha ?? sha(pr.head) ?? '0'.repeat(40);
    if (!pr.fork) branches[pr.head] = headSha;
    return {
      number: pr.number,
      title: pr.title ?? `Pull request ${pr.number}`,
      body: pr.body ?? '',
      base: 'main',
      head: pr.head,
      headSha,
      draft: pr.draft ?? false,
      state: pr.state ?? 'open',
      labels: pr.labels ?? ['sail'],
      ...(pr.ticketKey === undefined ? {} : { ticketKey: pr.ticketKey }),
      ...(pr.fork === undefined ? {} : { fork: pr.fork }),
      ...(pr.comments === undefined ? {} : { comments: pr.comments }),
    };
  });
  const world = { remote: 'fake://codehost/stub', defaultBranch: 'main', branches, pullRequests };
  write(sail, 'fake/prs.json', `${JSON.stringify(world, null, 2)}\n`);
}
