// `sail watch` over the scripted Linear and GitHub, started from an environment that holds neither LINEAR_API_KEY nor
// a GitHub token: the watcher reads the Linear key from the keychain item `linear-api-key` and the GitHub token from
// `gh auth token`, and the run it dispatches is a `sail` process that does the same for itself. Both tools are
// stand-ins on the PATH, and both values are markers.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeCredentialTools } from '../helpers/fake-credentials';
import { copyFixture, edit } from '../helpers/fixture';
import { createGitHubWorld } from '../helpers/github-world';
import { createLinearWorld, DEFAULT_STATES } from '../helpers/linear-world';
import { withOrigin } from '../helpers/origin';
import { gone, killOne, runsIn, sailProcess, until } from '../helpers/sail-process';
import { withTempRepo } from '../helpers/temp-repo';

const LINEAR_KEY = 'lin_api_MARKER_keychain_41c7a2f9';
const GITHUB_TOKEN = 'ghp_MARKER_keychain_7d03b9e5c1';
const WORKFLOW = 'ticket-to-pr';

test('sail watch starts with neither LINEAR_API_KEY nor a GitHub token, and the run it dispatches passes its own preflight and completes, the keys in no file of the run', async () => {
  const tools = mkdtempSync(join(tmpdir(), 'sail-test-tools-'));
  try {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo.dir, '.gitignore'), '.sail-runs/\n');
      repo.git('add', '.gitignore');
      repo.git('commit', '-q', '-m', 'ignore the runs');
      const origin = withOrigin(repo);
      const sail = copyFixture(repo.dir);
      edit(sail, 'project.yaml', 'workspace: { use: fake }', 'workspace: { use: git-worktree }');
      edit(
        sail,
        'project.yaml',
        'ticketSource: { use: fake, seed: ./fake/tickets.json }',
        'ticketSource: { use: linear, team: ADW }',
      );
      edit(
        sail,
        'project.yaml',
        'codeHost: { use: fake, seed: ./fake/prs.json }',
        'codeHost: { use: github, repository: o/r }',
      );
      repo.git('add', '.sail');
      repo.git('commit', '-q', '-m', 'definitions');
      repo.git('push', '-q', 'origin', 'main');
      const github = createGitHubWorld({
        owner: 'o',
        repo: 'r',
        defaultBranch: 'main',
        bare: origin.url,
        env: repo.env,
        token: GITHUB_TOKEN,
      });
      const linear = createLinearWorld({
        team: { key: 'ADW', states: DEFAULT_STATES },
        apiKey: LINEAR_KEY,
        tickets: [
          { number: 1, title: 'Add a greeting', description: 'Greet the user.', state: 'Todo', labels: ['sail'] },
        ],
      });
      const servedGitHub = github.serve();
      const servedLinear = linear.serve();
      const runs = join(repo.dir, '.sail-runs');
      const watcher = sailProcess(
        repo.dir,
        (() => {
          const { SAIL_GITHUB_TOKEN: _s, GITHUB_TOKEN: _g, LINEAR_API_KEY: _l, ...base } = repo.env;
          return {
            ...base,
            SAIL_GITHUB_API_URL: servedGitHub.url,
            SAIL_LINEAR_API_URL: servedLinear.url,
            SAIL_CREDENTIAL_LOOKUP: 'on',
            PATH: fakeCredentialTools(
              tools,
              { items: { 'linear-api-key': LINEAR_KEY }, ghToken: GITHUB_TOKEN },
              base.PATH,
            ),
          };
        })(),
        ['watch', WORKFLOW],
      );
      try {
        const settled = await until(
          'the dispatched run ended',
          () => runsIn(runs).length === 1 && runsIn(runs).every((run) => run.status === 'completed'),
        );
        expect(settled).toBe('the dispatched run ended');
        const [run] = runsIn(runs);
        expect([run?.ticketKey, run?.via, run?.status]).toEqual(['ADW-1', 'watch', 'completed']);
        expect(linear.requests.length).toBeGreaterThan(0);
        expect(github.requests.length).toBeGreaterThan(0);
        expect(linear.ticket(1).state).not.toBe('Todo');
        const text = Bun.spawnSync(['grep', '-rlE', `${LINEAR_KEY}|${GITHUB_TOKEN}`, runs]).stdout.toString();
        expect(text).toBe('');
      } finally {
        killOne(watcher.pid, 'SIGINT');
        await Promise.race([watcher.exited, Bun.sleep(30_000)]);
        if (watcher.exitCode === null) killOne(watcher.pid, 'SIGKILL');
        await gone(watcher.pid);
        servedGitHub.stop();
        servedLinear.stop();
      }
    });
  } finally {
    rmSync(tools, { recursive: true, force: true });
  }
}, 180_000);
