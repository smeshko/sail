// pi's bash commands run in process groups sail owns: each command's shell leads its own group, its environment is
// scrubbed of credentials, and reap() returns only after every group it started is gone.
import { expect, test } from 'bun:test';
import { bashEnv, createBashRunner } from '../../../src/adapters/pi/process';
import { withTempRepo } from '../../helpers/temp-repo';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const collect = () => {
  const chunks: Buffer[] = [];
  return { onData: (data: Buffer) => chunks.push(data), text: () => Buffer.concat(chunks).toString() };
};

/** The pid a command printed first, waiting up to 5 s for it. */
async function pidOf(out: { text(): string }): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (!out.text().includes('\n')) {
    if (Date.now() > deadline) throw new Error('the command printed no pid');
    await Bun.sleep(10);
  }
  return Number(out.text().trim());
}

test('a command’s output and exit code come back through the operations', async () => {
  await withTempRepo(async (repo) => {
    const runner = createBashRunner({ env: { PATH: repo.env.PATH ?? '/usr/bin:/bin' } });
    const out = collect();
    const end = await runner.operations.exec('echo hello; echo oops >&2; exit 3', repo.dir, { onData: out.onData });
    await runner.reap();
    expect({ end, text: out.text() }).toEqual({ end: { exitCode: 3 }, text: expect.stringContaining('hello') });
    expect(out.text()).toContain('oops');
  });
});

test('a command runs in the directory it is given, under the environment of the runner, not the one pi passes', async () => {
  await withTempRepo(async (repo) => {
    const runner = createBashRunner({ env: { PATH: repo.env.PATH ?? '/usr/bin:/bin', ONLY: 'ours' } });
    const out = collect();
    await runner.operations.exec('pwd -P; echo "$ONLY/$THEIRS"', repo.dir, {
      onData: out.onData,
      env: { THEIRS: 'pi’s', PATH: repo.env.PATH ?? '' },
    });
    await runner.reap();
    expect(out.text()).toBe(`${repo.dir}\nours/\n`);
  });
});

test('aborting a running sleep 47 and reaping leaves no process with its pid, and the command rejects as aborted', async () => {
  await withTempRepo(async (repo) => {
    const runner = createBashRunner({ env: { PATH: repo.env.PATH ?? '/usr/bin:/bin' } });
    const out = collect();
    const abort = new AbortController();
    const running = runner.operations.exec('echo $$; exec sleep 47', repo.dir, {
      onData: out.onData,
      signal: abort.signal,
    });
    const settled = running.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    const pid = await pidOf(out);
    expect(alive(pid)).toBe(true);
    abort.abort();
    await runner.reap();
    expect({ settled: await settled, alive: alive(pid) }).toEqual({ settled: 'aborted', alive: false });
  });
});

test('reap stops a command that is still running when the session ends, whatever started it', async () => {
  await withTempRepo(async (repo) => {
    const runner = createBashRunner({ env: { PATH: repo.env.PATH ?? '/usr/bin:/bin' } });
    const out = collect();
    const running = runner.operations.exec('echo $$; exec sleep 47', repo.dir, { onData: out.onData });
    const settled = running.then(
      () => 'resolved',
      () => 'rejected',
    );
    const pid = await pidOf(out);
    await runner.reap();
    expect({ alive: alive(pid), settled: await settled }).toEqual({ alive: false, settled: 'resolved' });
  });
});

test('reap stops a descendant left running in the group of a command that has already exited', async () => {
  await withTempRepo(async (repo) => {
    const runner = createBashRunner({ env: { PATH: repo.env.PATH ?? '/usr/bin:/bin' } });
    const out = collect();
    await runner.operations.exec('sleep 47 >/dev/null 2>&1 & echo $!', repo.dir, { onData: out.onData });
    const pid = Number(out.text().trim());
    const before = alive(pid);
    await runner.reap();
    expect({ before, after: alive(pid) }).toEqual({ before: true, after: false });
  });
});

test('a command that outlives its timeout is stopped and rejects naming the timeout', async () => {
  await withTempRepo(async (repo) => {
    const runner = createBashRunner({ env: { PATH: repo.env.PATH ?? '/usr/bin:/bin' } });
    const error = await runner.operations.exec('sleep 47', repo.dir, { onData: () => {}, timeout: 0.2 }).then(
      () => undefined,
      (e: Error) => e.message,
    );
    await runner.reap();
    expect(error).toBe('timeout:0.2');
  });
});

test('a signal aborted before the command starts rejects as aborted without running it', async () => {
  await withTempRepo(async (repo) => {
    const runner = createBashRunner({ env: { PATH: repo.env.PATH ?? '/usr/bin:/bin' } });
    const out = collect();
    const abort = new AbortController();
    abort.abort();
    const error = await runner.operations.exec('echo ran', repo.dir, { onData: out.onData, signal: abort.signal }).then(
      () => undefined,
      (e: Error) => e.message,
    );
    await runner.reap();
    expect({ error, text: out.text() }).toEqual({ error: 'aborted', text: '' });
  });
});

test('a working directory that does not exist rejects naming it', async () => {
  const runner = createBashRunner({ env: {} });
  const error = await runner.operations.exec('true', '/no/such/dir/for/sail', { onData: () => {} }).then(
    () => undefined,
    (e: Error) => e.message,
  );
  expect(error).toBe('Working directory does not exist: /no/such/dir/for/sail');
});

test('printenv ANTHROPIC_API_KEY through the operations prints nothing when the parent environment has it', () => {
  const env = bashEnv(
    { STAGE_OUT: '/out' },
    {
      PATH: '/bin',
      HOME: '/home/x',
      ANTHROPIC_API_KEY: 'sk-secret',
      OPENAI_API_KEY: 'sk-other',
      AWS_SECRET_ACCESS_KEY: 'a',
    },
  );
  expect(env).toEqual({ PATH: '/bin', HOME: '/home/x', STAGE_OUT: '/out', SHELL: '/bin/bash' });
});

test('the scrubbed environment reaches the shell: the key is unset there', async () => {
  await withTempRepo(async (repo) => {
    const runner = createBashRunner({
      env: bashEnv({ STAGE_OUT: '/out' }, { ...repo.env, ANTHROPIC_API_KEY: 'sk-secret' }),
    });
    const out = collect();
    await runner.operations.exec('printenv ANTHROPIC_API_KEY; echo "[$STAGE_OUT]"', repo.dir, { onData: out.onData });
    await runner.reap();
    expect(out.text()).toBe('[/out]\n');
  });
});

test('the preamble wins over a name the environment also has', () => {
  expect(bashEnv({ HOME: '/preamble' }, { HOME: '/home/x' }).HOME).toBe('/preamble');
});
