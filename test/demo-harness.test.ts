// sail's own demo harness, `.sail/lib/demo.mjs`: `new --own` makes a demo repository from the repository's own
// `.sail/` with every adapter on fake, while `--from` still refuses a `.sail/` whose ports aren't.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempRepo } from './helpers/temp-repo';

const ROOT = join(import.meta.dir, '..');
const DEMO = join(ROOT, '.sail', 'lib', 'demo.mjs');

async function demo(env: Record<string, string>, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, DEMO, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("new --own holds the repository's own .sail/ with every adapter, named harnesses too, on fake", async () => {
  await withTempRepo(async (repo) => {
    const dir = join(repo.dir, 'demo');
    const { code } = await demo(repo.env, 'new', dir, '--own');
    const project = Bun.YAML.parse(readFileSync(join(dir, 'repo', '.sail', 'project.yaml'), 'utf8')) as {
      adapters: Record<string, unknown>;
    };
    const own = Bun.YAML.parse(readFileSync(join(ROOT, '.sail', 'project.yaml'), 'utf8')) as {
      adapters: { harnesses?: Record<string, unknown> } & Record<string, unknown>;
    };
    const jev = JSON.parse(readFileSync(join(dir, 'repo', '.sail', 'fake', 'jev.json'), 'utf8'));
    // The fake factory's task and its fix pass's findings answer below a clear yes, so the check agents still run.
    const checks = ['TASK-001', 'V1', 'D1', 'R2'].map((id) => jev.answers?.[id]?.noul);
    expect(checks.every((noul: number | undefined) => noul !== undefined && noul < 0.95)).toBe(true);
    const { harnesses, ...ports } = own.adapters;
    expect({
      code,
      adapters: project.adapters,
      workflows: existsSync(join(dir, 'repo', '.sail', 'workflows', 'groom', 'workflow.ts')),
      conventions: existsSync(join(dir, 'repo', 'AGENTS.md')) && existsSync(join(dir, 'repo', 'CONTEXT.md')),
    }).toEqual({
      code: 0,
      adapters: {
        ...Object.fromEntries(Object.keys(ports).map((port) => [port, { use: 'fake' }])),
        ...(harnesses === undefined
          ? {}
          : { harnesses: Object.fromEntries(Object.keys(harnesses).map((name) => [name, { use: 'fake' }])) }),
      },
      workflows: true,
      conventions: true,
    });
  });
});

test("new --from the repository's own .sail/ is still refused: its ports aren't fake", async () => {
  await withTempRepo(async (repo) => {
    const { code, stderr } = await demo(repo.env, 'new', join(repo.dir, 'demo'), '--from', join(ROOT, '.sail'));
    expect({ code, refused: stderr.includes('every port must be on fake') }).toEqual({ code: 2, refused: true });
  });
});

test('new --runs copies a run directory under its runId and a .sail-runs folder as it is', async () => {
  await withTempRepo(async (repo) => {
    const dir = join(repo.dir, 'demo');
    const { code, stdout } = await demo(
      repo.env,
      'new',
      dir,
      '--runs',
      join(ROOT, 'test', 'fixtures', 'playback', 'fake-1-claude-code'),
      '--runs',
      join(ROOT, 'test', 'fixtures', 'dashboard', 'beta'),
    );
    const runs = join(dir, 'repo', '.sail-runs');
    const tracked = Bun.spawnSync(['git', 'ls-files', '.sail-runs'], { cwd: join(dir, 'repo'), env: repo.env });
    const files = new TextDecoder().decode(tracked.stdout);
    expect({
      code,
      seeded: stdout.includes('seeded .sail-runs/ from'),
      recorded: existsSync(join(runs, 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N', 'run.json')),
      beta: existsSync(join(runs, 'FAKE-3-01M39H4ZW0S46MV303CFX3T4PY', 'run.json')),
      queue: existsSync(join(runs, 'queue', 'ticket-to-pr', 'queue.json')),
      committed: files.includes('.sail-runs/queue/ticket-to-pr/queue.json'),
    }).toEqual({ code: 0, seeded: true, recorded: true, beta: true, queue: true, committed: true });
  });
});

test("new --runs refuses a folder that doesn't exist", async () => {
  await withTempRepo(async (repo) => {
    const dir = join(repo.dir, 'demo');
    const { code, stderr } = await demo(repo.env, 'new', dir, '--runs', join(repo.dir, 'missing'));
    expect({ code, named: stderr.includes('missing'), made: existsSync(join(dir, 'repo')) }).toEqual({
      code: 2,
      named: true,
      made: false,
    });
  });
});

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'chromium',
  'chromium-browser',
];
function findChrome(): string | undefined {
  const named = process.env.SAIL_DEMO_CHROME;
  for (const candidate of named ? [named] : CHROMES) {
    const found = candidate.startsWith('/') ? (existsSync(candidate) ? candidate : null) : Bun.which(candidate);
    if (found !== null) return found;
  }
  return undefined;
}
const chrome = findChrome();

const RECORDED = join(ROOT, 'test', 'fixtures', 'playback', 'fake-1-claude-code');
const RECORDED_RUN = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const TOOL = 'toolu_01AgSNycYkym43qwZ94yQvzK';

async function stepsRefusal(steps: string) {
  return await withTempRepo(async (repo) => {
    const file = join(repo.dir, 'steps.json');
    await Bun.write(file, steps);
    const dir = join(repo.dir, 'demo');
    const result = await demo(repo.env, 'dashboard', dir, 'x', `steps=${file}`);
    return { ...result, png: existsSync(join(dir, 'x-a.png')) || existsSync(join(dir, 'x.png')) };
  });
}

test('dashboard refuses a steps file that repeats a shot name', async () => {
  const { code, stderr, png } = await stepsRefusal('[{"shot":"a"},{"click":"body"},{"shot":"a"}]');
  expect({ code, named: stderr.includes('step 3') && stderr.includes('"a"'), png }).toEqual({
    code: 2,
    named: true,
    png: false,
  });
});

test("dashboard refuses a steps file with a step it doesn't know", async () => {
  const { code, stderr, png } = await stepsRefusal('[{"shot":"a"},{"hover":"body"}]');
  expect({ code, named: stderr.includes('step 2'), png }).toEqual({ code: 2, named: true, png: false });
});

test("dashboard refuses a steps file that isn't a JSON list", async () => {
  const { code, stderr, png } = await stepsRefusal('{"shot":"a"}');
  expect({ code, named: stderr.includes('list'), png }).toEqual({ code: 2, named: true, png: false });
});

async function seededDemo(repo: { dir: string; env: Record<string, string> }) {
  const dir = join(repo.dir, 'demo');
  expect((await demo(repo.env, 'new', dir, '--runs', RECORDED)).code).toBe(0);
  expect((await demo(repo.env, 'run', dir, 'sail', 'FAKE-1')).code).toBe(0);
  return dir;
}

test.skipIf(chrome === undefined)(
  "dashboard runs a steps file's clicks, scroll and shots on one load",
  async () => {
    await withTempRepo(async (repo) => {
      const dir = await seededDemo(repo);
      const card = '[data-action="select-card"][data-key="self-review#1"]';
      const scroller = `[data-scroll="input:${TOOL}"]`;
      const steps = [
        { wait: card },
        { click: card },
        { wait: `[data-call="${TOOL}"]` },
        { click: `[data-action="toggle-tool"][data-call="${TOOL}"]` },
        { wait: scroller },
        { scroll: scroller, top: 120 },
        { shot: 'one' },
        { click: '[data-action="toggle-filter"]' },
        { click: '[data-action="toggle-filter"]' },
        { shot: 'two' },
      ];
      const file = join(repo.dir, 'steps.json');
      await Bun.write(file, JSON.stringify(steps));
      const { code, stdout } = await demo(
        repo.env,
        'dashboard',
        dir,
        'cap',
        'repo=fixture',
        `run=${RECORDED_RUN}`,
        `steps=${file}`,
      );
      const scrolled = `scrolled input:${TOOL} 120`;
      expect({
        code,
        stepLines: stdout.split('\n').filter((line) => /^step \d+ /.test(line)).length,
        scrollStep: stdout.includes('scrollTop 120'),
        scrolledTwice: stdout.split(scrolled).length - 1,
        files: ['one', 'two']
          .flatMap((shot) => [`cap-${shot}.png`, `cap-${shot}.html`])
          .map((f) => existsSync(join(dir, f))),
        plain: existsSync(join(dir, 'cap.png')),
      }).toEqual({
        code: 0,
        stepLines: 10,
        scrollStep: true,
        scrolledTwice: 2,
        files: [true, true, true, true],
        plain: false,
      });
      expect(readFileSync(join(dir, 'cap-one.html'), 'utf8')).toContain('data-action="toggle-tool"');
    });
  },
  120_000,
);

test.skipIf(chrome === undefined)(
  'dashboard exits 1 naming the step a selector missed, keeping earlier shots',
  async () => {
    await withTempRepo(async (repo) => {
      const dir = await seededDemo(repo);
      const file = join(repo.dir, 'steps.json');
      await Bun.write(file, JSON.stringify([{ shot: 'before' }, { click: '#no-such-element' }, { shot: 'after' }]));
      const { code, stdout } = await demo(repo.env, 'dashboard', dir, 'miss', `steps=${file}`);
      expect({
        code,
        shot: /step 1 .*screenshot /s.test(stdout),
        named: /step 2 .*#no-such-element.* matched nothing/.test(stdout),
        before: existsSync(join(dir, 'miss-before.png')),
        after: existsSync(join(dir, 'miss-after.png')),
      }).toEqual({ code: 1, shot: true, named: true, before: true, after: false });
    });
  },
  120_000,
);

test.skipIf(chrome === undefined)(
  'dashboard without steps= still writes <name>.png and <name>.html',
  async () => {
    await withTempRepo(async (repo) => {
      const dir = await seededDemo(repo);
      const { code } = await demo(repo.env, 'dashboard', dir, 'plain', 'repo=fixture');
      expect({ code, png: existsSync(join(dir, 'plain.png')), html: existsSync(join(dir, 'plain.html')) }).toEqual({
        code: 0,
        png: true,
        html: true,
      });
    });
  },
  120_000,
);

test('dashboard refuses live= with no ticket key', async () => {
  const { code, stderr } = await withTempRepo(async (repo) =>
    demo(repo.env, 'dashboard', join(repo.dir, 'd'), 'x', 'live=fake-1'),
  );
  expect({ code, named: stderr.includes('ticket key') }).toEqual({ code: 2, named: true });
});

test.skipIf(chrome === undefined)(
  'dashboard live= starts the run, shows it, and leaves it suspended',
  async () => {
    await withTempRepo(async (repo) => {
      const dir = join(repo.dir, 'demo');
      expect((await demo(repo.env, 'new', dir)).code).toBe(0);
      const answers = join(dir, 'repo', '.sail', 'fake', 'harness.json');
      const paced = JSON.parse(readFileSync(answers, 'utf8')) as Record<
        string,
        { outcome: string; delayMs?: number }[]
      >;
      for (const list of Object.values(paced))
        for (const answer of list) if (answer.outcome === 'done') answer.delayMs = 5000;
      await Bun.write(answers, JSON.stringify(paced));
      const file = join(repo.dir, 'steps.json');
      await Bun.write(file, JSON.stringify([{ wait: 1000 }, { shot: 'running' }]));
      const { code, stdout } = await demo(repo.env, 'dashboard', dir, 'live', `steps=${file}`, 'live=FAKE-1');
      const id = /live (FAKE-1-\w+): suspended/.exec(stdout)?.[1];
      const status =
        id === undefined
          ? ''
          : (readFileSync(join(dir, 'repo', '.sail-runs', id, 'STATUS'), 'utf8').split('\n')[0] ?? '');
      expect({
        code,
        id: id !== undefined,
        url: id !== undefined && stdout.includes(`run=${id}`),
        status: status.split(' ')[0],
        reason: status.split(' ')[1],
        shot: existsSync(join(dir, 'live-running.png')),
      }).toEqual({ code: 0, id: true, url: true, status: 'suspended', reason: 'interrupted', shot: true });
    });
  },
  120_000,
);
