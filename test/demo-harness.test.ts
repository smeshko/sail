// sail's own demo harness, `.sail/lib/demo.mjs`: `new --own` makes a demo repository from the repository's own
// `.sail/` with every adapter on fake, while `--from` still refuses a `.sail/` whose ports aren't.
import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

test('new --runs leaves what a link in a seeded folder points to as it was', async () => {
  await withTempRepo(async (repo) => {
    const outside = join(repo.dir, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, 'key'), 'secret\n', { mode: 0o600 });
    const runs = join(repo.dir, 'runs');
    mkdirSync(runs);
    symlinkSync(outside, join(runs, 'link'));
    const { code } = await demo(repo.env, 'new', join(repo.dir, 'demo'), '--runs', runs);
    expect({
      code,
      folder: statSync(outside).mode & 0o777,
      key: statSync(join(outside, 'key')).mode & 0o777,
    }).toEqual({ code: 0, folder: 0o700, key: 0o600 });
  });
});

test('new --runs refuses a runId of dots, and one two folders share', async () => {
  await withTempRepo(async (repo) => {
    const seed = (name: string, runId: string) => {
      mkdirSync(join(repo.dir, name));
      writeFileSync(join(repo.dir, name, 'run.json'), JSON.stringify({ runId }));
      return join(repo.dir, name);
    };
    const dots = await demo(repo.env, 'new', join(repo.dir, 'a'), '--runs', seed('up', '..'));
    const twice = await demo(
      repo.env,
      'new',
      join(repo.dir, 'b'),
      '--runs',
      seed('one', 'FAKE-1-x'),
      '--runs',
      seed('two', 'FAKE-1-x'),
    );
    expect({
      dots: dots.code,
      twice: twice.code,
      named: twice.stderr.includes('FAKE-1-x'),
      made: existsSync(join(repo.dir, 'a', 'repo')) || existsSync(join(repo.dir, 'b', 'repo')),
    }).toEqual({ dots: 2, twice: 2, named: true, made: false });
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
        // Two redraws that keep the tool call's box: the tools filter would hide it.
        { click: '[data-action="toggle-filter"][data-filter="errors"]' },
        { click: '[data-action="toggle-filter"][data-filter="errors"]' },
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
  'dashboard exits 1 naming a missed scroll and a wait whose selector never came, and waits a time',
  async () => {
    await withTempRepo(async (repo) => {
      const dir = await seededDemo(repo);
      const capture = async (name: string, steps: unknown[]) => {
        const file = join(repo.dir, `${name}.json`);
        await Bun.write(file, JSON.stringify(steps));
        return await demo(repo.env, 'dashboard', dir, name, `steps=${file}`);
      };
      const scroll = await capture('scroll', [{ scroll: '#no-such-box', top: 10 }, { shot: 'after' }]);
      const wait = await capture('wait', [{ wait: '#never' }, { shot: 'after' }]);
      const timed = await capture('timed', [{ wait: 300 }, { shot: 'after' }]);
      expect({
        scroll: scroll.code,
        scrollNamed: /step 1 .*#no-such-box.* matched nothing/.test(scroll.stdout),
        wait: wait.code,
        waitNamed: /step 1 .*#never.* matched nothing within 20s/.test(wait.stdout),
        missedShots: existsSync(join(dir, 'scroll-after.png')) || existsSync(join(dir, 'wait-after.png')),
        timed: timed.code,
        waited: /step 1 \{"wait":300\}: waited \d+ms/.test(timed.stdout),
        timedShot: existsSync(join(dir, 'timed-after.png')),
      }).toEqual({
        scroll: 1,
        scrollNamed: true,
        wait: 1,
        waitNamed: true,
        missedShots: false,
        timed: 0,
        waited: true,
        timedShot: true,
      });
    });
  },
  180_000,
);

test.skipIf(chrome === undefined)(
  'dashboard shoots what a click redrew, with no wait between them',
  async () => {
    await withTempRepo(async (repo) => {
      const dir = await seededDemo(repo);
      const card = '[data-action="select-card"][data-key="self-review#1"]';
      const file = join(repo.dir, 'steps.json');
      await Bun.write(file, JSON.stringify([{ wait: card }, { click: card }, { shot: 'opened' }]));
      const { code } = await demo(
        repo.env,
        'dashboard',
        dir,
        'redraw',
        'repo=fixture',
        `run=${RECORDED_RUN}`,
        `steps=${file}`,
      );
      expect({
        code,
        timeline: readFileSync(join(dir, 'redraw-opened.html'), 'utf8').includes(`data-call="${TOOL}"`),
      }).toEqual({
        code: 0,
        timeline: true,
      });
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
      // The shot is of the live run while a call of it runs, not of an empty page or another run.
      const page = readFileSync(join(dir, 'live-running.html'), 'utf8');
      expect({
        run: id !== undefined && page.includes(id),
        running: /class="pill [\w-]+">running<\/span>/.test(page),
      }).toEqual({
        run: true,
        running: true,
      });
    });
  },
  120_000,
);

const DENSE = join(ROOT, 'test', 'fixtures', 'dashboard', 'dense');

test('new --clone registers a clone under the demo, with the folder as its .sail-runs/ and an entry the registry reads', async () => {
  await withTempRepo(async (repo) => {
    const dir = join(repo.dir, 'demo');
    const { code, stdout } = await demo(
      repo.env,
      'new',
      dir,
      '--clone',
      `atlas=${join(DENSE, 'atlas')}`,
      '--clone',
      `ember=${join(DENSE, 'ember')}`,
    );
    const entry = JSON.parse(readFileSync(join(dir, 'home', '.sail', 'watchers', 'atlas.json'), 'utf8'));
    expect({
      code,
      printed: stdout.split('\n').filter((line) => line.startsWith('demo: registered')),
      runs: readdirSync(join(dir, 'clones', 'atlas', '.sail-runs')).filter((name) => name.startsWith('ATL-')).length,
      queue: existsSync(join(dir, 'clones', 'atlas', '.sail-runs', 'queue', 'ticket-to-pr', 'queue.json')),
      entry: { ...entry, updatedAt: typeof entry.updatedAt },
      sailDir: existsSync(entry.sailDir),
      second: existsSync(join(dir, 'home', '.sail', 'watchers', 'ember.json')),
    }).toEqual({
      code: 0,
      printed: ['demo: registered atlas', 'demo: registered ember'],
      runs: 10,
      queue: true,
      entry: {
        schema: 'sail.registry.v1',
        name: 'atlas',
        remote: 'https://example.com/atlas.git',
        clone: join(dir, 'clones', 'atlas'),
        sailDir: join(dir, 'clones', 'atlas', '.sail'),
        updatedAt: 'string',
      },
      sailDir: true,
      second: true,
    });
  });
});

test('new --clone refuses a bad name, a folder that is none and a name given twice, naming each, and makes nothing', async () => {
  await withTempRepo(async (repo) => {
    const dir = join(repo.dir, 'demo');
    const bad = await demo(repo.env, 'new', dir, '--clone', `a/b=${join(DENSE, 'atlas')}`);
    const missing = await demo(repo.env, 'new', dir, '--clone', `atlas=${join(repo.dir, 'nowhere')}`);
    const twice = await demo(
      repo.env,
      'new',
      dir,
      '--clone',
      `atlas=${join(DENSE, 'atlas')}`,
      '--clone',
      `atlas=${join(DENSE, 'ember')}`,
    );
    const noEquals = await demo(repo.env, 'new', dir, '--clone', join(DENSE, 'atlas'));
    expect({
      bad: [bad.code, bad.stderr.includes('a/b')],
      missing: [missing.code, missing.stderr.includes('nowhere')],
      twice: [twice.code, twice.stderr.includes('atlas') && twice.stderr.includes('twice')],
      noEquals: noEquals.code,
      made: existsSync(dir),
    }).toEqual({ bad: [2, true], missing: [2, true], twice: [2, true], noEquals: 2, made: false });
  });
});

/** A Chrome that does nothing but write its arguments, one a line, to `<dir>/chrome-args.txt`, and exit. */
async function recordingChrome(dir: string) {
  const script = join(dir, 'chrome.sh');
  await Bun.write(script, `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${join(dir, 'chrome-args.txt')}"\n`);
  chmodSync(script, 0o755);
  return script;
}

test('dashboard width=1280 starts Chrome with a 1280-wide window, 1440 without, and sends no width parameter', async () => {
  await withTempRepo(async (repo) => {
    const dir = join(repo.dir, 'demo');
    const env = { ...repo.env, SAIL_DEMO_CHROME: await recordingChrome(repo.dir) };
    expect((await demo(env, 'new', dir)).code).toBe(0);
    const args = () => readFileSync(join(repo.dir, 'chrome-args.txt'), 'utf8').split('\n');
    await demo(env, 'dashboard', dir, 'wide', 'width=1280');
    expect(args()).toContain('--window-size=1280,900');
    expect(args().some((arg) => arg.includes('width='))).toBe(false);
    await demo(env, 'dashboard', dir, 'plain');
    expect(args()).toContain('--window-size=1440,900');
    expect(args()).not.toContain('--window-size=1280,900');
  });
}, 60_000);

test('dashboard refuses a width that is no whole number from 800 to 2560 before Chrome starts', async () => {
  await withTempRepo(async (repo) => {
    const dir = join(repo.dir, 'demo');
    const env = { ...repo.env, SAIL_DEMO_CHROME: await recordingChrome(repo.dir) };
    expect((await demo(env, 'new', dir)).code).toBe(0);
    const refused = [];
    for (const width of ['abc', '1280.5', '799', '2561', '-1']) {
      const { code, stderr } = await demo(env, 'dashboard', dir, 'x', `width=${width}`);
      refused.push([width, code, stderr.includes('width')]);
    }
    expect(refused).toEqual([
      ['abc', 2, true],
      ['1280.5', 2, true],
      ['799', 2, true],
      ['2561', 2, true],
      ['-1', 2, true],
    ]);
    expect(existsSync(join(repo.dir, 'chrome-args.txt'))).toBe(false);
    for (const width of ['800', '2560']) {
      await demo(env, 'dashboard', dir, 'edge', `width=${width}`);
      expect(readFileSync(join(repo.dir, 'chrome-args.txt'), 'utf8')).toContain(`--window-size=${width},900`);
    }
  });
}, 60_000);
