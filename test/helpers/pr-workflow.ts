// What the pull-request tests share (DECISIONS D13): a stub pull-request workflow, a watched ticket workflow that opens
// a pull request, and the fake CodeHost's seed, written into a test's temp repository beside the stub from
// `writeStub()`. The committed fixture repository is left as it is.
//
// - `writePrWorkflow()` writes `review-pr` (or another name): the built-in `pr` intake and one agent stage, `review`,
//   that binds the input, `diff.patch` and `brief.md`. Its prompt prints the pull request's title and body, so a test can
//   find them wrapped in the rendered `prompt.md`. The fake harness answers `review#1`: its first try waits `delayMs`,
//   so a test can interrupt it, and every later try answers at once.
// - `writePublishingWorkflow()` writes a watched ticket workflow whose one script stage, `open`, commits a file, pushes
//   the run's branch and opens a pull request labelled `sail` with the run's ticket key, as the fixture's `open` does,
//   then holds at the stub's gate (`setHoldAt('open#1')`) while it still holds the branch's lease.
// - `seedPullRequests()` writes the fake CodeHost's seed from real commits: `branches.main` is the repository's main,
//   and each pull request's head is the sha its branch points at, so a workspace can start there.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Writes workflow `name` into the stub `.sail/`: a watched ticket workflow whose `open` stage commits a file, pushes the
 * run's branch and opens its pull request labelled `sail`, naming the run's ticket, then holds at the stub's gate when
 * `setHoldAt('open#1')` set one.
 */
export function writePublishingWorkflow(sail: string, name: string, watch: { label: string; cap: number }): void {
  const dir = `workflows/${name}`;
  write(
    sail,
    `${dir}/stages/open/stage.ts`,
    `// open: the change, pushed to the run's branch, and its pull request.
import { script, value, z } from 'sail';

export const open = script('open', {
  run: './run.sh',
  // The ticket key as plain text, so the script reads it with no JSON parser.
  consumes: { ticketKey: value(z.string()) },
  output: z.object({ number: z.number().int(), url: z.string(), headSha: z.string() }),
});
`,
  );
  const run = write(
    sail,
    `${dir}/stages/open/run.sh`,
    `#!/usr/bin/env bash
# open: commits a file in the run's workspace, pushes it as $BRANCH and opens its pull request labelled sail. Then it
# holds at the stub's gate, while the run still holds the branch, until a test opens the gate.
set -euo pipefail
STUB="$(dirname "$(dirname "$SAIL_CONFIG")")/.stub"
ticket=$(cat "$INPUT_TICKETKEY")
echo "$RUN_ID" >"$WORKSPACE/change-$ticket.txt"
git -C "$WORKSPACE" add "change-$ticket.txt"
git -C "$WORKSPACE" -c user.name=sail -c user.email=sail@example.invalid commit -q -m "the change for $ticket"
pushed=$(sail port codehost push "$BRANCH")
printf 'The change for %s.\\n' "$ticket" >"$STAGE_OUT/body.md"
pr=$(sail port codehost open-pull-request --base main --head "$BRANCH" --title "The change for $ticket" \\
  --body-file "$STAGE_OUT/body.md" --ticket "$ticket" --label sail)
if [ -f "$STUB/hold-at" ] && [ "$(cat "$STUB/hold-at")" = "$STAGE#$CALL" ] && [ ! -f "$STUB/release" ]; then
  mkdir -p "$STUB/held"
  echo "$$" >"$STUB/held/$RUN_ID.$TRY"
  waited=0
  while [ ! -f "$STUB/release" ]; do
    if [ "$waited" -ge 600 ]; then exit 1; fi
    sleep 0.1
    waited=$((waited + 1))
  done
fi
printf '%s\\n%s\\n' "$pr" "$pushed" | "\${SAIL_BUN:-bun}" -e '
const [pr, pushed] = (await Bun.stdin.text()).trim().split("\\n").map((line) => JSON.parse(line));
console.log(JSON.stringify({ number: pr.number, url: pr.url, headSha: pushed.headSha }));
'
`,
  );
  chmodSync(run, 0o755);
  write(
    sail,
    `${dir}/workflow.ts`,
    `// ${name}: a watched ticket workflow that only opens its ticket's pull request.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { open } from './stages/open/stage';

export default workflow(
  '${name}',
  { intake: ticket, version: 1, watch: { every: '30s', label: '${watch.label}' }, maxConcurrentRuns: ${watch.cap} },
  async (run) => run.stage(open, { ticketKey: run.input.ticketKey }),
);
`,
  );
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
