// The Milestone E demonstration: the fixture's `land` against GitHub and Linear themselves, on demand. It runs only when
// SAIL_LIVE_LAND=1, and without the switch nothing here is registered, so no request leaves the machine.
//
//   SAIL_LIVE_GITHUB_REPOSITORY   the sandbox repository, as owner/name
//   SAIL_LIVE_LAND_TICKET         a designated ticket in Todo, whose run lands one pull request
//   SAIL_LIVE_LINEAR_TEAM         its team's key
//   SAIL_LIVE_LINEAR_LABEL        the designation label
//   SAIL_LIVE_LINEAR_IN_REVIEW    the team's started state that in-review moves to, such as In Review
//   GITHUB_TOKEN                  read per command from `gh auth token`, never written anywhere
//   LINEAR_API_KEY                read per command from the keychain, never written anywhere
//
// It clones the sandbox into a temporary repository, copies the fixture's `.sail/` there with a project.yaml on linear,
// github, git-worktree and the fake harness, and runs `sail <ticket> --workflow land`. It then checks every claim against
// GitHub and Linear directly, never against the run's own records alone, and deletes the pull request's branch.
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import { addLand, copyFixture } from '../helpers/fixture';
import { deleteBranch, liveFetch } from '../helpers/live-github';
import { withTempRepo } from '../helpers/temp-repo';

const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');

if (process.env.SAIL_LIVE_LAND === '1') {
  // A clone, a run of five steps against GitHub and Linear, and the reads after it.
  setDefaultTimeout(300_000);

  const need = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === '') throw new Error(`the land demonstration needs ${name}`);
    return value;
  };
  /** What the evidence records once the run is over, and the branch the cleanup deletes. */
  const landed: { runId?: string; url?: string; sha?: string; branch?: string } = {};
  afterAll(async () => {
    if (landed.branch !== undefined)
      await deleteBranch(need('GITHUB_TOKEN'), need('SAIL_LIVE_GITHUB_REPOSITORY'), landed.branch);
    console.log(`land demonstration: run ${landed.runId} · ${landed.url} · merged as ${landed.sha}`);
  });

  test('land on the sandbox merges a real pull request at the head it opened, with the merge commit GitHub reports, swaps its label, and leaves the ticket in review with a comment naming the run', async () => {
    const repository = need('SAIL_LIVE_GITHUB_REPOSITORY');
    const ticket = need('SAIL_LIVE_LAND_TICKET');
    const token = need('GITHUB_TOKEN');
    const inReview = need('SAIL_LIVE_LINEAR_IN_REVIEW');
    const linear = {
      team: need('SAIL_LIVE_LINEAR_TEAM'),
      label: need('SAIL_LIVE_LINEAR_LABEL'),
      key: need('LINEAR_API_KEY'),
    };
    await withTempRepo(async (temp) => {
      // The token reaches git through an askpass that reads it from the environment: no URL or file holds it.
      const askpass = join(temp.home, 'askpass.sh');
      writeFileSync(
        askpass,
        '#!/bin/sh\ncase "$1" in Username*) echo x-access-token ;; *) echo "$GITHUB_TOKEN" ;; esac\n',
      );
      chmodSync(askpass, 0o700);
      const env = { ...temp.env, GITHUB_TOKEN: token, LINEAR_API_KEY: linear.key, GIT_ASKPASS: askpass };
      const clone = join(dirname(temp.dir), 'sandbox');
      const cloned = Bun.spawnSync(['git', 'clone', '-q', `https://github.com/${repository}.git`, clone], {
        env,
        stdin: 'ignore',
      });
      expect(cloned.exitCode).toBe(0);
      // The workspace's git blanks GIT_ASKPASS on purpose, so its fetch asks the clone's own helper, which reads the
      // token from the environment when git asks: no file holds it.
      const helper = '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f';
      const configured = Bun.spawnSync(['git', '-C', clone, 'config', 'credential.helper', helper], { env });
      expect(configured.exitCode).toBe(0);
      writeFileSync(join(clone, '.git', 'info', 'exclude'), '.sail-runs/\n');
      const sail = addLand(copyFixture(clone));
      writeFileSync(
        join(sail, 'project.yaml'),
        [
          '# The land demonstration: the sandbox on Linear and GitHub, the fake harness.',
          'name: land-live',
          'sail: ">=0.0.0 <1"',
          `label: ${linear.label}`,
          'defaultWorkflow: land',
          'adapters:',
          `  ticketSource: { use: linear, team: ${linear.team}, inReview: ${inReview} }`,
          `  codeHost: { use: github, repository: ${repository} }`,
          '  harness: { use: fake }',
          '  workspace: { use: git-worktree }',
          '',
        ].join('\n'),
      );
      const sailIn = (...argv: string[]) => {
        const ran = Bun.spawnSync([process.execPath, MAIN, ...argv], { cwd: clone, env, stdin: 'ignore' });
        return { code: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
      };

      const run = sailIn(ticket, '--workflow', 'land');
      const runs = join(clone, '.sail-runs');
      const [runId = ''] = existsSync(runs) ? readdirSync(runs).filter((name) => name !== 'fake') : [];
      const dir = join(runs, runId);
      const events = runId === '' ? [] : readEvents(dir);
      const merged = events.find((event) => event.type === 'codehost:merged') as { sha: string } | undefined;
      const published = JSON.parse(readFileSync(join(dir, '01-publish', 'call-1', 'result.json'), 'utf8')).output as {
        number: number;
        url: string;
        headSha: string;
      };
      Object.assign(landed, { runId, url: published.url, sha: merged?.sha });
      expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: '' });

      const pr = (await liveFetch(token, 'GET', `/repos/${repository}/pulls/${published.number}`)) as {
        merged: boolean;
        merge_commit_sha: string;
        head: { sha: string; ref: string };
        labels: { name: string }[];
      };
      landed.branch = pr.head.ref;
      const read = sailIn('port', 'ticket-source', 'get', ticket);
      const got = JSON.parse(read.stdout) as { state: { name: string }; comments: { body: string }[] };
      const shown = sailIn('show', runId, '--events', '-vv');
      expect({
        merged: [pr.merged, pr.merge_commit_sha],
        head: pr.head.sha,
        labels: pr.labels.map((label) => label.name).filter((name) => name.startsWith('sail')),
        ticket: [
          got.state.name,
          got.comments.some((comment) => comment.body === `sail run ${runId} landing ${published.url}`),
        ],
        shown: [
          shown.code,
          shown.stdout
            .split('\n')
            .some((line) => line.includes('codehost:merged') && line.includes(merged?.sha ?? '?')),
        ],
        issues: validateRunDir(dir).issues,
      }).toEqual({
        merged: [true, merged?.sha ?? 'no codehost:merged'],
        head: published.headSha,
        labels: ['sail-landed'],
        ticket: [inReview, true],
        shown: [0, true],
        issues: [],
      });
    });
  });
}
