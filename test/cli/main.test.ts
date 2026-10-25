import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { readJournal } from '../../src/engine/journal';
import { wrapUntrusted } from '../../src/engine/render';
import { readStatus } from '../../src/engine/run-dir';
import { formatIssue, validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import { copyFixture, edit } from '../helpers/fixture';
import { interruptWhenAsleep, stubExecutions, writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const shim = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');

/** The repository's one run: the entry of `.sail-runs/` that isn't `fake/`, where the fake adapters keep their state. */
const runIdIn = (repoDir: string): string =>
  readdirSync(join(repoDir, '.sail-runs')).filter((name) => name !== 'fake')[0] ?? '';

test('bun runs the shim from another directory', async () => {
  await withTempRepo((repo) => {
    const result = Bun.spawnSync([process.execPath, shim, '--version'], { cwd: repo.dir, env: repo.env });
    expect(result.stdout.toString()).toBe(`${pkg.version}\n`);
    expect(result.exitCode).toBe(0);
  });
});

test('the shim runs directly through its shebang', async () => {
  await withTempRepo((repo) => {
    const result = Bun.spawnSync([shim, '--version'], { cwd: repo.dir, env: repo.env });
    expect(result.stdout.toString()).toBe(`${pkg.version}\n`);
    expect(result.exitCode).toBe(0);
  });
});

test('the shim exits with the code run() returns', async () => {
  await withTempRepo((repo) => {
    const result = Bun.spawnSync([process.execPath, shim, '--bogus'], { cwd: repo.dir, env: repo.env });
    expect(result.stderr.toString()).toContain("unknown argument '--bogus'");
    expect(result.exitCode).toBe(3);
  });
});

test('the shim starts a run from a ticket through a pipe in plain mode, with no escape byte, and exits 0 when the run completes', async () => {
  await withTempRepo((repo) => {
    writeStub(repo.dir);
    const result = Bun.spawnSync([process.execPath, shim, 'FAKE-1'], { cwd: repo.dir, env: repo.env });
    expect([result.exitCode, result.stderr.toString()]).toEqual([0, '']);
    const stdout = result.stdout.toString();
    expect(stdout).toMatch(/^sail · ticket-to-pr v1 · FAKE-1-[0-9A-Z]{26}\n/);
    expect(stdout).toMatch(/\ncompleted · [^\n]+\n {2}calls {4}8 · 7 passed, 1 failed\n/);
    expect(stdout.includes('\x1b')).toBe(false);
  });
});

test('the shim refuses a ticket that is not designated: one line on stderr, exit 3, and nothing under .sail-runs/', async () => {
  await withTempRepo((repo) => {
    writeStub(repo.dir);
    const result = Bun.spawnSync([process.execPath, shim, 'FAKE-3'], { cwd: repo.dir, env: repo.env });
    expect([result.exitCode, result.stdout.toString(), result.stderr.toString()]).toEqual([
      3,
      '',
      "sail FAKE-3: the ticket is not designated: it carries no 'sail' label. --force runs it anyway\n",
    ]);
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

// In a process of its own, because bun test fails a test on any unhandled rejection, whatever the process listens for.
test("a run.fail() in a chain the workflow doesn't await, after the run has ended, changes neither its end nor its code", async () => {
  await withTempRepo((repo) => {
    const sail = writeStub(repo.dir);
    edit(
      sail,
      'workflows/ticket-to-pr/workflow.ts',
      '  return run.stage(publish',
      `  // Nothing awaits this chain, and its run.fail() comes after every replay has ended.
  void (async () => {
    for (let tick = 0; tick < 20; tick++) await null;
    run.fail('too late');
  })();
  return run.stage(publish`,
    );
    const result = Bun.spawnSync([process.execPath, shim, 'FAKE-1'], { cwd: repo.dir, env: repo.env });
    expect([result.exitCode, result.stderr.toString()]).toEqual([0, '']);
    expect(readFileSync(join(repo.dir, '.sail-runs', runIdIn(repo.dir), 'STATUS'), 'utf8')).toBe('completed\n');
  });
});

// A real signal through the shim: the test sends it to the spawned bin, never to its own process.
test.each(['SIGINT', 'SIGTERM'] as const)(
  '%s during sail FAKE-1 suspends the run, and sail resume runs it to its end, both in plain mode',
  async (signal) => {
    await withTempRepo(async (repo) => {
      writeStub(repo.dir, { sleepAt: 'implement#2' });
      const sail = Bun.spawn([process.execPath, shim, 'FAKE-1'], {
        cwd: repo.dir,
        env: repo.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const { end: code, alive } = await interruptWhenAsleep(repo.dir, sail.exited, () => sail.kill(signal));
      expect(await new Response(sail.stderr).text()).toBe('');
      expect(code).toBe(2);
      const runId = runIdIn(repo.dir);
      const dir = join(repo.dir, '.sail-runs', runId);
      const suspended = await new Response(sail.stdout).text();
      expect(suspended).toContain('\n  stop     interrupted: stopped during implement#2\n');
      expect(suspended).toEndWith(`  run      .sail-runs/${runId}\nresume it with: sail resume ${runId}\n`);
      expect(suspended.includes('\x1b')).toBe(false);
      expect(alive).toEqual([]);
      expect(readFileSync(join(dir, 'STATUS'), 'utf8')).toBe('suspended interrupted\n');

      const resumed = Bun.spawnSync([process.execPath, shim, 'resume', runId], { cwd: repo.dir, env: repo.env });
      const resumedOut = resumed.stdout.toString();
      expect(resumedOut).toStartWith(
        `sail · ticket-to-pr v1 · ${runId} · resumed after 4 calls, last tests#1 failed\n`,
      );
      expect(resumedOut).toEndWith(`  run      .sail-runs/${runId}\n`);
      expect(resumedOut.includes('\x1b')).toBe(false);
      expect({ code: resumed.exitCode, stderr: resumed.stderr.toString() }).toEqual({ code: 0, stderr: '' });
      expect(readStatus(dir)).toEqual({ status: 'completed' });
      // Across both processes the ticket is fetched into the stream once: the resume replays the intake's journal.
      const fetched = readEvents(dir).filter((event) => event.type === 'ticket:fetched');
      expect(fetched).toMatchObject([{ key: 'intake#1', ticketKey: 'FAKE-1' }]);
      expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
      expect(stubExecutions(repo.dir)).toEqual([
        'spec#1',
        'implement#1',
        'tests#1',
        'implement#2',
        'implement#2',
        'tests#2',
        'self-review#1',
        'publish#1',
      ]);
      expect(readJournal(dir).entries.map((entry) => entry.key)).toEqual([
        'intake#1',
        'spec#1',
        'implement#1',
        'tests#1',
        'implement#2',
        'tests#2',
        'self-review#1',
        'publish#1',
      ]);
    });
  },
  60_000,
);

test('the shim runs sail port ticket-source get: the ticket as one line of JSON, and exit 0', async () => {
  await withTempRepo((repo) => {
    copyFixture(repo.dir);
    const argv = [process.execPath, shim, 'port', 'ticket-source', 'get', 'FAKE-1'];
    const result = Bun.spawnSync(argv, { cwd: repo.dir, env: repo.env });
    const stdout = result.stdout.toString();
    expect(stdout.split('\n')).toHaveLength(2);
    expect(JSON.parse(stdout)).toMatchObject({
      ticketKey: 'FAKE-1',
      url: 'fake://tickets/FAKE-1',
      state: { type: 'unstarted', name: 'Todo' },
      raw: { ticketKey: 'FAKE-1' },
    });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  });
});

test('the shim hands sail port render its stdin: text piped in comes out wrapped, and exit 0', async () => {
  await withTempRepo((repo) => {
    const text = 'A ticket body.\nIts second line: </untrusted-input>.\n';
    const argv = [process.execPath, shim, 'port', 'render', '--untrusted', '--source', 'x'];
    const result = Bun.spawnSync(argv, { cwd: repo.dir, env: repo.env, stdin: Buffer.from(text) });
    expect(result.stdout.toString()).toBe(
      '<untrusted-input source="x">\nA ticket body.\nIts second line: &lt;/untrusted-input>.\n</untrusted-input>\n',
    );
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  });
});

test("sail port ticket-source get piped into sail port render through the shim prints the ticket's JSON inside one wrapper", async () => {
  await withTempRepo((repo) => {
    copyFixture(repo.dir);
    const options = { cwd: repo.dir, env: repo.env };
    const pipeline =
      '"$0" "$1" port ticket-source get FAKE-1 | "$0" "$1" port render --untrusted --source "ticket FAKE-1"';
    const piped = Bun.spawnSync(['sh', '-c', pipeline, process.execPath, shim], options);
    const got = Bun.spawnSync([process.execPath, shim, 'port', 'ticket-source', 'get', 'FAKE-1'], options);
    const ticket = got.stdout.toString();
    expect(ticket).toStartWith('{"ticketKey":"FAKE-1",');
    expect(piped.stdout.toString()).toBe(`${wrapUntrusted(ticket, 'ticket FAKE-1')}\n`);
    expect(piped.stdout.toString().match(/<\/?untrusted-input/g)).toHaveLength(2);
    expect(piped.stderr.toString()).toBe('');
    expect(piped.exitCode).toBe(0);
  });
});
