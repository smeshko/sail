// `sail port codehost`, in process through run(): each CodeHost operation on the fake, from a temporary repository that
// holds a copy of the fixture's `.sail/`, whose seed has pull requests 1 to 4. Arguments go in as flags and
// positionals, a result comes out as one line of JSON, and the fake keeps what it changed in
// `.sail-runs/fake/prs.json`, so two commands see one world, as two processes do.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { run } from '../../src/cli/index';
import { PullRequest, PullRequestDetails, Pushed } from '../../src/ports/types';
import { copyFixture, edit, write } from '../helpers/fixture';
import { type CaptureOptions, runCaptured } from '../helpers/run-captured';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const TICKET_USAGE =
  'usage: sail port ticket-source get|links|attachments <ticket>\n       sail port ticket-source comment <ticket> [--body-file <path>]\n';
const UPDATE_USAGE = '       sail port ticket-source update <ticket> --state <unstarted|in-progress|in-review|done>\n';
const CREATE_USAGE = '       sail port ticket-source create --title <text> [--label <name>]... [--body-file <path>]\n';
const ATTACH_USAGE =
  '       sail port ticket-source attach <ticket> --file <path> [--title <text>] [--content-type <type>]\n';
const PUSH_USAGE = '       sail port codehost push <branch>\n';
const OPEN_USAGE =
  '       sail port codehost open-pull-request --base <branch> --head <branch> --title <text> [--body-file <path>] [--draft] [--ticket <ticket key>] [--label <name>]...\n';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory outside any git repository. */
function outside(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-port-codehost-')));
  dirs.push(dir);
  return dir;
}

/** `sail port codehost <args>` from the repository, or from `cwd`, in the repository's environment plus `env`. */
function codehost(
  repo: TempRepo,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
) {
  const capture: CaptureOptions = { env: { ...repo.env, ...options.env } };
  if (options.stdin !== undefined) capture.stdin = options.stdin;
  return runCaptured(['port', 'codehost', ...args], options.cwd ?? repo.dir, capture);
}

/** The one line a command printed, parsed, after checking that it is one line and a newline. */
function oneLine(stdout: string): Record<string, unknown> {
  expect(stdout.split('\n')).toHaveLength(2);
  expect(stdout.endsWith('\n')).toBe(true);
  return JSON.parse(stdout);
}

/** What the fake code host holds now: its state file. */
const world = (repoDir: string) => JSON.parse(readFileSync(join(repoDir, '.sail-runs', 'fake', 'prs.json'), 'utf8'));

/** The events a command appended to `file`, one per line: none when it wrote no file. */
const appended = (file: string): Record<string, unknown>[] =>
  (existsSync(file) ? readFileSync(file, 'utf8') : '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));

/** The arguments of an `open-pull-request` from `head` into `main`, titled `A title`. */
const opening = (head: string, ...more: string[]) => [
  'open-pull-request',
  '--base',
  'main',
  '--head',
  head,
  '--title',
  'A title',
  ...more,
];

test("push pushes HEAD as the branch and prints the port's Pushed as one line of JSON, and the fake's state file holds the branch", async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const headSha = repo.git('rev-parse', 'HEAD');
    const { code, stdout, stderr } = await codehost(repo, ['push', 'sail/FAKE-9']);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const printed = oneLine(stdout);
    expect(printed).toEqual({ branch: 'sail/FAKE-9', headSha, raw: { branch: 'sail/FAKE-9', headSha } });
    expect<unknown>(Pushed.parse(printed)).toEqual(printed);
    expect(world(repo.dir).branches['sail/FAKE-9']).toBe(headSha);
  });
});

test("open-pull-request prints the port's PullRequest: the next number after the seed's highest, both labels in the order given, the ticket key as given, open and no draft, with the body the file holds", async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    writeFileSync(join(repo.dir, 'body.md'), 'Adds the flag.\n\nCloses FAKE-9.\n');
    await codehost(repo, ['push', 'sail/FAKE-9']);
    const flags = ['--body-file', 'body.md', '--ticket', 'FAKE-9', '--label', 'sail', '--label', 'review'];
    const { code, stdout, stderr } = await codehost(repo, opening('sail/FAKE-9', ...flags));
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const { raw, ...printed } = oneLine(stdout);
    expect(printed).toEqual({
      number: 5,
      url: 'fake://codehost/fixture/pull/5',
      title: 'A title',
      base: 'main',
      head: 'sail/FAKE-9',
      headSha: repo.git('rev-parse', 'HEAD'),
      draft: false,
      state: 'open',
      labels: ['sail', 'review'],
      ticketKey: 'FAKE-9',
    });
    expect<unknown>(PullRequest.parse({ ...printed, raw })).toEqual({ ...printed, raw });
    expect(raw).toMatchObject({ number: 5, body: 'Adds the flag.\n\nCloses FAKE-9.\n' });
    expect(world(repo.dir).pullRequests.at(-1)).toEqual(raw);
  });
});

test('--draft opens a draft, and with neither --ticket nor --label the pull request has no ticket key and no label', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    await codehost(repo, ['push', 'sail/FAKE-9']);
    const { code, stdout } = await codehost(repo, opening('sail/FAKE-9', '--draft'), { stdin: 'A draft.\n' });
    expect(code).toBe(EXIT_OK);
    const { raw: _raw, ...printed } = oneLine(stdout);
    expect(printed).toMatchObject({ number: 5, draft: true, state: 'open', labels: [] });
    expect(Object.keys(printed)).not.toContain('ticketKey');
  });
});

test('without --body-file the body is all of stdin, and with neither a file nor a stdin it exits 3 before anything is opened', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    await codehost(repo, ['push', 'sail/FAKE-9']);
    const refused = await codehost(repo, opening('sail/FAKE-9'));
    expect(refused.code).toBe(EXIT_REFUSED);
    expect(refused.stderr).toStartWith(
      `sail port: codehost open-pull-request reads its body from --body-file or stdin, and there is neither\n${TICKET_USAGE}`,
    );
    expect(world(repo.dir).pullRequests).toHaveLength(4);

    const opened = await codehost(repo, opening('sail/FAKE-9'), { stdin: 'From stdin.\nTwo lines.\n' });
    expect(opened.code).toBe(EXIT_OK);
    expect(oneLine(opened.stdout).raw).toMatchObject({ number: 5, body: 'From stdin.\nTwo lines.\n' });
  });
});

test("a --body-file that can't be read exits 3 with why, and nothing is opened", async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    await codehost(repo, ['push', 'sail/FAKE-9']);
    // Stdin is there, and is not the fallback: the file was named.
    const refused = await codehost(repo, opening('sail/FAKE-9', '--body-file', 'missing.md'), { stdin: 'unused' });
    expect(refused).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: "sail port: can't read --body-file missing.md: ENOENT\n",
    });
    expect(world(repo.dir).pullRequests).toHaveLength(4);
  });
});

test('--body-file is read relative to the working directory, and push pushes the checkout it runs from', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    await withTempRepo(async (other) => {
      // Another checkout, with another HEAD and its own body.md, reaching the first's `.sail/` through SAIL_CONFIG.
      writeFileSync(join(other.dir, 'body.md'), "The other checkout's body.\n");
      other.git('add', 'body.md');
      other.git('commit', '-m', 'body');
      const there = { cwd: other.dir, env: { SAIL_CONFIG: join(sail, 'project.yaml') } };
      const pushed = await codehost(repo, ['push', 'sail/FAKE-9'], there);
      expect(oneLine(pushed.stdout).headSha).toBe(other.git('rev-parse', 'HEAD'));
      expect(other.git('rev-parse', 'HEAD')).not.toBe(repo.git('rev-parse', 'HEAD'));
      const opened = await codehost(repo, opening('sail/FAKE-9', '--body-file', 'body.md'), there);
      expect(oneLine(opened.stdout).raw).toMatchObject({ body: "The other checkout's body.\n" });
    });
  });
});

test.each<[string, string[], string]>([
  [
    '--base',
    ['open-pull-request', '--head', 'sail/x', '--title', 'T'],
    'codehost open-pull-request needs --base <branch>',
  ],
  [
    '--head',
    ['open-pull-request', '--base', 'main', '--title', 'T'],
    'codehost open-pull-request needs --head <branch>',
  ],
  [
    '--title',
    ['open-pull-request', '--base', 'main', '--head', 'sail/x'],
    'codehost open-pull-request needs --title <text>',
  ],
  ['its branch', ['push'], 'codehost push needs a branch'],
  ['nothing but has a positional too many', [...opening('sail/x'), 'extra'], "unknown argument 'extra'"],
])(
  'an operation that lacks %s exits 3, saying so and printing the usage, and calls no port',
  async (_, args, problem) => {
    await withTempRepo(async (repo) => {
      copyFixture(repo.dir);
      const { code, stdout, stderr } = await codehost(repo, args, { stdin: 'body' });
      expect({ code, stdout }).toEqual({ code: EXIT_REFUSED, stdout: '' });
      expect(stderr).toStartWith(`sail port: ${problem}\n${TICKET_USAGE}`);
      expect(stderr).toContain(`\n${PUSH_USAGE}${OPEN_USAGE}`);
      expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
    });
  },
);

test("push outside a git checkout exits 1 with the port's message and code", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const cwd = outside();
    const pushed = await codehost(repo, ['push', 'sail/FAKE-9'], {
      cwd,
      env: { SAIL_CONFIG: join(sail, 'project.yaml') },
    });
    expect({ code: pushed.code, stdout: pushed.stdout }).toEqual({ code: EXIT_FAILED, stdout: '' });
    expect(pushed.stderr).toStartWith(`sail port: codeHost.push: ${cwd} is not a git checkout: `);
    expect(pushed.stderr).toEndWith(' (invalid)\n');
  });
});

test('open-pull-request from a head that was never pushed exits 1 as invalid', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    expect(await codehost(repo, opening('sail/x'), { stdin: 'body' })).toEqual({
      code: EXIT_FAILED,
      stdout: '',
      stderr: 'sail port: codeHost.openPullRequest: sail/x was never pushed (invalid)\n',
    });
  });
});

test('a second open-pull-request from the same head into the same base exits 0 and prints the same pull request, with the label it lacked added', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    await codehost(repo, ['push', 'sail/x']);
    const first = await codehost(repo, opening('sail/x'), { stdin: 'body' });
    const again = await codehost(repo, opening('sail/x', '--label', 'sail'), { stdin: 'another body' });
    const { raw: _first, ...opened } = oneLine(first.stdout);
    const { raw: _again, ...reopened } = oneLine(again.stdout);
    expect({ codes: [first.code, again.code], stderr: again.stderr, reopened }).toEqual({
      codes: [EXIT_OK, EXIT_OK],
      stderr: '',
      reopened: { ...opened, labels: ['sail'] },
    });
    expect(world(repo.dir).pullRequests).toHaveLength(5);
  });
});

test('push of the default branch, main, exits 1 as invalid, and the fake records no push', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const pushed = await codehost(repo, ['push', 'main']);
    expect([pushed, existsSync(join(repo.dir, '.sail-runs', 'fake', 'prs.json'))]).toEqual([
      { code: EXIT_FAILED, stdout: '', stderr: 'sail port: codeHost.push: main is the default branch (invalid)\n' },
      false,
    ]);
  });
});

test.each<[string, string[], string]>([
  [
    '--title given to push',
    ['codehost', 'push', 'sail/x', '--title', 'T'],
    "option '--title' belongs to sail port ticket-source create or sail port ticket-source attach or sail port codehost open-pull-request",
  ],
  [
    '--label given to ticket-source get',
    ['ticket-source', 'get', 'FAKE-1', '--label', 'sail'],
    "option '--label' belongs to sail port ticket-source create or sail port codehost open-pull-request",
  ],
])('%s exits 3, naming the operation the option belongs to, and calls no port', async (_, argv, problem) => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const { code, stdout, stderr } = await runCaptured(['port', ...argv], repo.dir, { env: repo.env });
    expect({ code, stdout }).toEqual({ code: EXIT_REFUSED, stdout: '' });
    expect(stderr).toStartWith(`sail port: ${problem}\n${TICKET_USAGE}`);
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test("an operation the code host does not have exits 3, naming it, and so do codehost with no operation and with an option of render's", async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const unknown = await codehost(repo, ['nonsense']);
    expect(unknown.code).toBe(EXIT_REFUSED);
    expect(unknown.stderr).toStartWith(`sail port: unknown operation 'nonsense' of codehost\n${TICKET_USAGE}`);
    const none = await codehost(repo, []);
    expect(none.code).toBe(EXIT_REFUSED);
    expect(none.stderr).toStartWith(
      `sail port: no operation given for codehost\n${TICKET_USAGE}${UPDATE_USAGE}${CREATE_USAGE}${ATTACH_USAGE}${PUSH_USAGE}`,
    );
    // An option of render's is refused for the code host as it is for the ticket source.
    const untrusted = await codehost(repo, ['push', 'sail/x', '--untrusted']);
    expect(untrusted.code).toBe(EXIT_REFUSED);
    expect(untrusted.stderr).toStartWith(
      `sail port: option '--untrusted' belongs to sail port render\n${TICKET_USAGE}`,
    );
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test("only the code host is resolved: with the harness on the fixture's own adapter and its token unset, push and open-pull-request still run", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    edit(sail, 'project.yaml', 'harness: { use: fake }', 'harness: { use: ./adapters/echo-harness.ts }');
    // A run of this repository is refused for the token the harness needs.
    const run = await runCaptured(['FAKE-1'], repo.dir, { env: repo.env });
    expect([run.code, run.stderr]).toEqual([EXIT_REFUSED, expect.stringContaining('/adapters/harness needs ')]);
    expect((await codehost(repo, ['push', 'sail/FAKE-9'])).code).toBe(EXIT_OK);
    const opened = await codehost(repo, opening('sail/FAKE-9'), { stdin: 'body' });
    expect([opened.code, oneLine(opened.stdout).number]).toEqual([EXIT_OK, 5]);
  });
});

test('with SAIL_EVENTS set, push appends codehost:pushed, and open-pull-request appends codehost:pr_opened and then one codehost:labelled per label', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const file = join(repo.dir, 'port-events.ndjson');
    const env = { SAIL_EVENTS: file };
    const headSha = repo.git('rev-parse', 'HEAD');
    await codehost(repo, ['push', 'sail/FAKE-9'], { env });
    expect(appended(file)).toEqual([{ type: 'codehost:pushed', branch: 'sail/FAKE-9', headSha }]);
    const flags = ['--ticket', 'FAKE-9', '--label', 'sail', '--label', 'review'];
    await codehost(repo, opening('sail/FAKE-9', ...flags), { env, stdin: 'body' });
    expect(appended(file).slice(1)).toEqual([
      {
        type: 'codehost:pr_opened',
        number: 5,
        url: 'fake://codehost/fixture/pull/5',
        draft: false,
        base: 'main',
        head: 'sail/FAKE-9',
        ticketKey: 'FAKE-9',
      },
      { type: 'codehost:labelled', number: 5, label: 'sail', change: 'added' },
      { type: 'codehost:labelled', number: 5, label: 'review', change: 'added' },
    ]);
  });
});

const ODD_HOST = `// A code host of the repository's own, whose push answers with no Pushed.
const nothing = async () => undefined;

export default {
  create: () => ({
    name: 'odd',
    parseRef: () => undefined,
    push: async () => ({ branch: 7, headSha: 'abc', raw: null }),
    openPullRequest: nothing,
    listDesignated: nothing,
    getPullRequest: nothing,
    checks: nothing,
    merge: nothing,
    addLabel: nothing,
    removeLabel: nothing,
    comment: nothing,
    capabilities: () => ({ checks: true, labels: true, drafts: true, mergeMethods: ['merge'] }),
  }),
};
`;

test("an answer that is not the port's, from a repository's own code host, exits 1 naming the operation and where the answer is wrong", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    write(sail, 'adapters/odd-host.ts', ODD_HOST);
    edit(
      sail,
      'project.yaml',
      'codeHost: { use: fake, seed: ./fake/prs.json }',
      'codeHost: { use: ./adapters/odd-host.ts }',
    );
    expect(await codehost(repo, ['push', 'sail/FAKE-9'])).toEqual({
      code: EXIT_FAILED,
      stdout: '',
      stderr:
        'sail port: codeHost.push: its answer is not a Pushed: branch Invalid input: expected string, received number (invalid)\n',
    });
  });
});

// The other seven operations, on the seed's pull requests: 1 is open and labelled `sail`, 2 is a draft, 3 merges on the
// second ask, and 4's check goes from pending to failed. A merge names the head it expects, each seed's own.

const HEAD = {
  1: 'b4efb0c5de84d87c1455d4504b8b75b095a8e10b',
  2: '3c7e1a0d9b2f4e6a8c0b1d3f5a7c9e1b3d5f7a90',
  3: '5d2b8f4a6c0e1d3b5f7a9c1e3b5d7f9a1c3e5b70',
  4: '7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a50',
} as const;

const USAGE = `${TICKET_USAGE}${UPDATE_USAGE}${CREATE_USAGE}${ATTACH_USAGE}${PUSH_USAGE}${OPEN_USAGE}       sail port codehost get-pull-request|checks <pr>
       sail port codehost list-designated <label>
       sail port codehost merge <pr> --method <merge|squash|rebase> --expected-head-sha <sha>
       sail port codehost add-label|remove-label <pr> <label>
       sail port codehost comment <pr> [--body-file <path>]
       sail port render --untrusted --source <text> [--inline]
`;

test("get-pull-request prints the pull request with its details, as the port's PullRequestDetails, named by its number, by #number or by its URL", async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const byNumber = await codehost(repo, ['get-pull-request', '1']);
    expect({ code: byNumber.code, stderr: byNumber.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const printed = oneLine(byNumber.stdout);
    expect(printed).toMatchObject({
      number: 1,
      url: 'fake://codehost/fixture/pull/1',
      base: 'main',
      draft: false,
      state: 'open',
      labels: ['sail'],
      body: "Links the changelog from the README's first section.",
      author: 'sail',
      baseSha: 'f569e7f50659194ebd39f2f141e95091f40791da',
      fork: false,
      comments: [],
    });
    expect<unknown>(PullRequestDetails.parse(printed)).toEqual(printed);
    for (const ref of ['#1', 'fake://codehost/fixture/pull/1']) {
      expect(await codehost(repo, ['get-pull-request', ref])).toEqual(byNumber);
    }
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test("a ref the adapter's parseRef does not take exits 3, naming it, and a pull request the host does not have exits 1 with the port's message", async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    for (const ref of ['abc', 'https://example.com/pull/1', '0']) {
      expect(await codehost(repo, ['get-pull-request', ref])).toEqual({
        code: EXIT_REFUSED,
        stdout: '',
        stderr: `sail port: '${ref}' is not a pull request of the fake code host: a number, or a URL it owns\n`,
      });
    }
    expect(await codehost(repo, ['get-pull-request', '99'])).toEqual({
      code: EXIT_FAILED,
      stdout: '',
      stderr: 'sail port: codeHost.getPullRequest: no pull request #99 (not_found)\n',
    });
  });
});

test('list-designated prints the open, non-draft pull requests that carry the label as a JSON array in number order, and [] for a label none carries', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const { code, stdout, stderr } = await codehost(repo, ['list-designated', 'sail']);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const listed = oneLine(stdout) as unknown as Record<string, unknown>[];
    expect(listed.map((pr) => [pr.number, pr.draft, pr.state])).toEqual([
      [1, false, 'open'],
      [3, false, 'open'],
      [4, false, 'open'],
    ]);
    expect<unknown>(listed.map((pr) => PullRequest.parse(pr))).toEqual(listed);
    expect(await codehost(repo, ['list-designated', 'no-such-label'])).toEqual({
      code: EXIT_OK,
      stdout: '[]\n',
      stderr: '',
    });
  });
});

test("checks prints the port's Checks, and the fake's script carries on between two commands: pending, then failed", async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const first = oneLine((await codehost(repo, ['checks', '4'])).stdout);
    const second = oneLine((await codehost(repo, ['checks', '#4'])).stdout);
    expect([first.number, first.checks, second.checks]).toEqual([
      4,
      [{ name: 'ci', status: 'pending' }],
      [{ name: 'ci', status: 'failed' }],
    ]);
    expect(first.headSha).toBe(world(repo.dir).pullRequests[3].headSha);
  });
});

test('a merge the host answers pending or refused is a printed result with exit code 0, and one that lands prints merged with its sha', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const merge = async (...args: string[]) => {
      const { code, stdout, stderr } = await codehost(repo, ['merge', ...args]);
      const { raw: _raw, ...result } = oneLine(stdout);
      return { code, stderr, result };
    };
    expect(await merge('3', '--method', 'squash', '--expected-head-sha', HEAD[3])).toEqual({
      code: EXIT_OK,
      stderr: '',
      result: { state: 'pending', reason: 'fake: merge scripted pending' },
    });
    expect(await merge('3', '--method', 'squash', '--expected-head-sha', HEAD[3])).toEqual({
      code: EXIT_OK,
      stderr: '',
      result: { state: 'merged', sha: expect.stringMatching(/^[0-9a-f]{40}$/) },
    });
    expect(world(repo.dir).pullRequests[2].state).toBe('merged');
    expect(await merge('2', '--method', 'merge', '--expected-head-sha', HEAD[2])).toEqual({
      code: EXIT_OK,
      stderr: '',
      result: { state: 'refused', reason: 'fake: pull request #2 is a draft' },
    });
  });
});

test('merge with no --method or no --expected-head-sha exits 3 with the usage, and a method the port does not know, or an expected head that is no sha, exits 1 with its message: nothing merges', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const none = await codehost(repo, ['merge', '1', '--expected-head-sha', HEAD[1]]);
    expect([none.code, none.stdout, none.stderr]).toEqual([
      EXIT_REFUSED,
      '',
      `sail port: codehost merge needs --method <merge|squash|rebase>\n${USAGE}`,
    ]);
    const headless = await codehost(repo, ['merge', '1', '--method', 'squash']);
    expect([headless.code, headless.stdout, headless.stderr]).toEqual([
      EXIT_REFUSED,
      '',
      `sail port: codehost merge needs --expected-head-sha <sha>\n${USAGE}`,
    ]);
    expect(await codehost(repo, ['merge', '1', '--method', 'fast', '--expected-head-sha', HEAD[1]])).toEqual({
      code: EXIT_FAILED,
      stdout: '',
      stderr: 'sail port: codeHost.merge: fast is not a merge method (invalid)\n',
    });
    expect(await codehost(repo, ['merge', '1', '--method', 'squash', '--expected-head-sha', 'b4efb0c'])).toEqual({
      code: EXIT_FAILED,
      stdout: '',
      stderr: 'sail port: codeHost.merge: expectedHeadSha "b4efb0c" is not a 40-character hex sha (invalid)\n',
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test('a merge whose expected head is not the head of the pull request prints refused, naming both shas, exits 0, and leaves it open with no event in the port events file', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const file = join(repo.dir, 'port-events.ndjson');
    writeFileSync(file, '');
    const stale = '0'.repeat(40);
    const { code, stdout, stderr } = await codehost(
      repo,
      ['merge', '1', '--method', 'squash', '--expected-head-sha', stale],
      { env: { SAIL_EVENTS: file } },
    );
    const { raw: _raw, ...result } = oneLine(stdout);
    expect({ code, stderr, result, state: world(repo.dir).pullRequests[0].state, events: appended(file) }).toEqual({
      code: EXIT_OK,
      stderr: '',
      result: { state: 'refused', reason: `fake: head moved: expected ${stale}, pull request #1 is at ${HEAD[1]}` },
      state: 'open',
      events: [],
    });
  });
});

test('a merge the host rejects exits 1 with its message, and leaves one error:port with it in the port events file and no codehost:merged', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    edit(sail, 'fake/prs.json', '"merges": ["pending", "merged"]', '"merges": ["rejected"]');
    const file = join(repo.dir, 'port-events.ndjson');
    writeFileSync(file, '');
    const merged = await codehost(repo, ['merge', '3', '--method', 'squash', '--expected-head-sha', HEAD[3]], {
      env: { SAIL_EVENTS: file },
    });
    expect(merged).toEqual({
      code: EXIT_FAILED,
      stdout: '',
      stderr: 'sail port: codeHost.merge: fake: merge rejected (scripted) (conflict)\n',
    });
    expect({ state: world(repo.dir).pullRequests[2].state, events: appended(file) }).toEqual({
      state: 'open',
      events: [
        {
          type: 'error:port',
          port: 'codeHost',
          op: 'merge',
          code: 'conflict',
          message: 'codeHost.merge: fake: merge rejected (scripted)',
        },
      ],
    });
  });
});

test('a read of a pull request the host does not have leaves one error:port of code not_found in the port events file', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const file = join(repo.dir, 'port-events.ndjson');
    const read = await codehost(repo, ['get-pull-request', '99'], { env: { SAIL_EVENTS: file } });
    expect([read.code, appended(file)]).toEqual([
      EXIT_FAILED,
      [
        {
          type: 'error:port',
          port: 'codeHost',
          op: 'getPullRequest',
          code: 'not_found',
          message: 'codeHost.getPullRequest: no pull request #99',
        },
      ],
    ]);
  });
});

test("add-label prints the pull request's labels with the new one, and remove-label prints them without it", async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const labels = async (operation: string) => {
      const { code, stdout } = await codehost(repo, [operation, '1', 'needs-review']);
      const { raw: _raw, ...labelled } = oneLine(stdout);
      return { code, labelled };
    };
    expect(await labels('add-label')).toEqual({
      code: EXIT_OK,
      labelled: { number: 1, labels: ['sail', 'needs-review'] },
    });
    expect(world(repo.dir).pullRequests[0].labels).toEqual(['sail', 'needs-review']);
    expect(await labels('remove-label')).toEqual({ code: EXIT_OK, labelled: { number: 1, labels: ['sail'] } });
  });
});

test("comment posts the body from --body-file, or from stdin without it, and prints the port's Posted with an id and a URL each time", async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    writeFileSync(join(repo.dir, 'note.md'), 'From the file.\n');
    const fromFile = await codehost(repo, ['comment', '1', '--body-file', 'note.md']);
    const fromStdin = await codehost(repo, ['comment', '#1'], { stdin: 'From stdin.\n' });
    expect([fromFile.code, fromStdin.code]).toEqual([EXIT_OK, EXIT_OK]);
    const posted = [fromFile, fromStdin].map(({ stdout }) => {
      const { raw: _raw, ...rest } = oneLine(stdout);
      return rest;
    });
    expect(posted).toEqual([
      { id: 'comment-1', url: 'fake://codehost/fixture/pull/1#comment-1' },
      { id: 'comment-2', url: 'fake://codehost/fixture/pull/1#comment-2' },
    ]);
    const bodies = world(repo.dir).pullRequests[0].comments.map((comment: { body: string }) => comment.body);
    expect(bodies).toEqual(['From the file.\n', 'From stdin.\n']);

    const neither = await codehost(repo, ['comment', '1']);
    expect([neither.code, neither.stderr]).toEqual([
      EXIT_REFUSED,
      `sail port: codehost comment reads its body from --body-file or stdin, and there is neither\n${USAGE}`,
    ]);
    expect(world(repo.dir).pullRequests[0].comments).toHaveLength(2);
  });
});

test('with SAIL_EVENTS set, each operation appends what its adapter emitted: checks, a merge that landed, a label that changed and a comment each one event, and a read, a merge that did not land and a label already there none', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const file = join(repo.dir, 'port-events.ndjson');
    writeFileSync(file, '');
    const env = { SAIL_EVENTS: file };
    /** The events `args` appended, by type. */
    const emitted = async (args: string[], stdin?: string) => {
      const before = appended(file).length;
      const { code } = await codehost(repo, args, stdin === undefined ? { env } : { env, stdin });
      expect(code).toBe(EXIT_OK);
      return appended(file).slice(before);
    };
    expect(await emitted(['get-pull-request', '1'])).toEqual([]);
    expect(await emitted(['list-designated', 'sail'])).toEqual([]);
    const seed = JSON.parse(readFileSync(join(repo.dir, '.sail', 'fake', 'prs.json'), 'utf8'));
    const { headSha } = seed.pullRequests[3];
    expect(await emitted(['checks', '4'])).toEqual([
      { type: 'codehost:checks', number: 4, headSha, checks: [{ name: 'ci', status: 'pending' }] },
    ]);
    const merging = ['merge', '3', '--method', 'squash', '--expected-head-sha', HEAD[3]];
    expect(await emitted(merging)).toEqual([]);
    expect(await emitted(merging)).toEqual([
      { type: 'codehost:merged', number: 3, method: 'squash', sha: expect.stringMatching(/^[0-9a-f]{40}$/) },
    ]);
    expect(await emitted(['add-label', '1', 'sail'])).toEqual([]);
    expect(await emitted(['add-label', '1', 'needs-review'])).toEqual([
      { type: 'codehost:labelled', number: 1, label: 'needs-review', change: 'added' },
    ]);
    expect(await emitted(['remove-label', '1', 'needs-review'])).toEqual([
      { type: 'codehost:labelled', number: 1, label: 'needs-review', change: 'removed' },
    ]);
    expect(await emitted(['comment', '1'], 'Looks good.')).toEqual([
      { type: 'codehost:commented', number: 1, body: 'Looks good.' },
    ]);
  });
});

test.each<[string[], string]>([
  [['get-pull-request'], 'codehost get-pull-request needs a pull request'],
  [['get-pull-request', '1', 'extra'], "unknown argument 'extra'"],
  [['list-designated'], 'codehost list-designated needs a label'],
  [['list-designated', 'sail', 'extra'], "unknown argument 'extra'"],
  [['checks'], 'codehost checks needs a pull request'],
  [['checks', '4', 'extra'], "unknown argument 'extra'"],
  [['merge', '--method', 'squash', '--expected-head-sha', HEAD[3]], 'codehost merge needs a pull request'],
  [['merge', '3', 'extra', '--method', 'squash', '--expected-head-sha', HEAD[3]], "unknown argument 'extra'"],
  [['add-label'], 'codehost add-label needs a pull request'],
  [['add-label', '1'], 'codehost add-label needs a label'],
  [['remove-label', '1'], 'codehost remove-label needs a label'],
  [['comment'], 'codehost comment needs a pull request'],
  [['comment', '1', 'extra'], "unknown argument 'extra'"],
  [['push', 'sail/x', 'extra'], "unknown argument 'extra'"],
])('sail port codehost %j exits 3 with the usage of every operation, and calls no port', async (args, problem) => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    expect(await codehost(repo, args, { stdin: 'body' })).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: `sail port: ${problem}\n${USAGE}`,
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test.each<[string, string[], string]>([
  [
    '--method given to checks',
    ['checks', '4', '--method', 'squash'],
    "option '--method' belongs to sail port codehost merge",
  ],
  [
    '--base given to merge',
    ['merge', '3', '--method', 'squash', '--expected-head-sha', HEAD[3], '--base', 'main'],
    "option '--base' belongs to sail port codehost open-pull-request",
  ],
  [
    '--body-file given to add-label',
    ['add-label', '1', 'x', '--body-file', 'note.md'],
    "option '--body-file' belongs to sail port ticket-source comment or sail port ticket-source create or sail port codehost open-pull-request or sail port codehost comment",
  ],
])('%s exits 3, naming where the option belongs', async (_, args, problem) => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    expect(await codehost(repo, args)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: `sail port: ${problem}\n${USAGE}`,
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test('a usage error of sail port prints every operation of ticket-source and codehost, and render', async () => {
  await withTempRepo(async (repo) => {
    for (const [argv, problem] of [
      [['port'], 'no port given'],
      [['port', 'nonsense'], "unknown port 'nonsense'"],
      [['port', 'ticket-source'], 'no operation given for ticket-source'],
      [['port', 'render'], 'render needs --untrusted: it wraps untrusted input, and nothing else yet'],
    ] as const) {
      expect(await runCaptured(argv, repo.dir)).toEqual({
        code: EXIT_REFUSED,
        stdout: '',
        stderr: `sail port: ${problem}\n${USAGE}`,
      });
    }
  });
});

test.each<[string, string[], { stdin: string }, string]>([
  ['comment with an empty stdin, as a script step has', ['comment', '1'], { stdin: '' }, 'stdin'],
  ['comment with a stdin of blank lines', ['comment', '1'], { stdin: ' \n\n' }, 'stdin'],
  [
    'comment with an empty --body-file',
    ['comment', '1', '--body-file', 'empty.md'],
    { stdin: 'unused' },
    '--body-file empty.md',
  ],
  ['open-pull-request with an empty stdin', opening('sail/FAKE-9'), { stdin: '' }, 'stdin'],
  [
    'open-pull-request with an empty --body-file',
    opening('sail/FAKE-9', '--body-file', 'empty.md'),
    { stdin: 'unused' },
    '--body-file empty.md',
  ],
])('%s exits 3 before the port is called: an empty body is no body', async (_, args, options, where) => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    writeFileSync(join(repo.dir, 'empty.md'), '\n');
    await codehost(repo, ['push', 'sail/FAKE-9']);
    const before = world(repo.dir);
    expect(await codehost(repo, args, options)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: `sail port: codehost ${args[0]} needs a body, and ${where} is empty\n`,
    });
    expect(world(repo.dir)).toEqual(before);
  });
});

test('through the real bin, whose stdin is always there, a comment with nothing on stdin is refused and nothing is posted', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts'),
        'port',
        'codehost',
        'comment',
        '1',
      ],
      {
        cwd: repo.dir,
        env: repo.env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect({ code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: 'sail port: codehost comment needs a body, and stdin is empty\n',
    });
    expect(existsSync(join(repo.dir, '.sail-runs', 'fake', 'prs.json'))).toBe(false);
  });
});

test('comment on a reference that is no pull request is refused before stdin is read: a stdin that never ends is never waited for', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    let reads = 0;
    let stderr = '';
    const code = await run(['port', 'codehost', 'comment', 'abc'], {
      cwd: repo.dir,
      env: repo.env,
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      stdin: () => {
        reads++;
        return new Promise<string>(() => {});
      },
    });
    expect({ code, stderr, reads }).toEqual({
      code: EXIT_REFUSED,
      stderr: "sail port: 'abc' is not a pull request of the fake code host: a number, or a URL it owns\n",
      reads: 0,
    });
  });
});
