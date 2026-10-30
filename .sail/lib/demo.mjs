// The demo harness: a scratch repository with every port on `fake`, and this checkout's sail run in it with a clean
// environment, so a stage can show a change working at runtime at $0. Nothing it does writes to the checkout.
// Usage: bun .sail/lib/demo.mjs <command> …, or .sail/lib/demo.sh <command> …
//   new <dir> [--from <sail-dir>]  a git repository at <dir>/repo holding a copy of <sail-dir>, the fixture
//                                  repository's .sail/ when left out, and the HOME its commands get, at <dir>/home
//   new <dir> --own                the same, holding this checkout's own .sail/ with every adapter put on fake, its
//                                  seeds the ones under .sail/fake/
//   new <dir> … --runs <folder>   with either form, seeds <dir>/repo/.sail-runs/ before the first commit; repeatable. A
//                                  folder holding run.json is copied in under its runId, any other folder's entries
//                                  as they are (a .sail-runs/ with its runs and queue/)
//   run <dir> sail [args…]         commits what changed in <dir>/repo, runs this checkout's sail there, prints what
//                                  it printed and appends it to <dir>/transcript.txt; exits with sail's code. Only
//                                  sail runs, so a stage allowed this harness runs nothing else through it
//   dashboard <dir> <name> [repo=… run=… key=… tab=… steps=… live=…]
//                                  serves <dir>'s runs with this checkout's `sail dashboard`, opens it in headless
//                                  Chrome on the run, call and tab named, writes what Chrome drew to <dir>/<name>.png
//                                  and the page's DOM to <dir>/<name>.html, and stops the dashboard whatever happens.
//                                  Each selection is a word of its own, not a query: a command gate reads a quoted
//                                  `&` as a background job. Chrome is found where it installs, or named by
//                                  SAIL_DEMO_CHROME
//     steps=<file>                 a JSON list of steps run in order on one page load, each shot written to
//                                  <name>-<shot>.png and .html: {"click": css}, {"scroll": css, "top": px},
//                                  {"wait": css} (up to 20s) or {"wait": ms}, and {"shot": name}. The transcript
//                                  prints each step, and a `scrolled` line per box left scrolled down. A selector
//                                  that matches nothing exits 1 and names the step; earlier shots stay
//     live=<ticket key>            starts `sail <ticket key>` in <dir>/repo, opens the page on that run unless run=
//                                  names another, and interrupts it once the steps end, leaving it suspended
// The environment a command gets is built from nothing: no SAIL_CONFIG, SAIL_EVENTS or SAIL_BUN from a step around
// it, no keys, and a HOME, SAIL_HOME and git identity of its own. A repository whose ports aren't all fake is refused.
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..', '..');
const FIXTURE_SAIL = join(root, 'test', 'fixtures', 'repo', '.sail');
const PORTS = ['ticketSource', 'codeHost', 'harness', 'workspace'];
const TIMEOUT_SECONDS = 300;
const PRINTED = 20000;
const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'chromium',
  'chromium-browser',
];
/** The page fills in from its sockets after load: it is captured once its DOM hasn't changed for SETTLE_MS. */
const SETTLE_MS = 1500;
/** How long Chrome may take to start, and a page to settle. */
const CAPTURE_SECONDS = 60;
/** How long a click's redraw may take to settle before the next step runs anyway. */
const CLICK_SECONDS = 5;
/** How long a step may wait for a selector to appear. */
const WAIT_SECONDS = 20;

function refuse(message) {
  console.error(`demo: ${message}`);
  process.exit(2);
}

/** The environment every command in `dir` gets: nothing inherited but where to find programs. */
function envOf(dir) {
  const home = join(dir, 'home');
  return {
    PATH: [join(root, 'bin'), dirname(process.execPath), process.env.PATH ?? '/usr/bin:/bin'].join(':'),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    SAIL_HOME: join(home, '.sail'),
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'sail demo',
    GIT_AUTHOR_EMAIL: 'demo@sail.invalid',
    GIT_COMMITTER_NAME: 'sail demo',
    GIT_COMMITTER_EMAIL: 'demo@sail.invalid',
  };
}

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: join(dir, 'repo'), env: envOf(dir), encoding: 'utf8' });
  if (result.status !== 0) refuse(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Refuses a repository whose project.yaml puts any port on an adapter other than `fake`. */
function checkFake(sailDir, missing) {
  const config = join(sailDir, 'project.yaml');
  if (!existsSync(config)) refuse(missing);
  const adapters = Bun.YAML.parse(readFileSync(config, 'utf8'))?.adapters ?? {};
  const real = PORTS.filter((port) => adapters[port]?.use !== 'fake');
  if (real.length > 0) refuse(`every port must be on fake, and ${real.join(', ')} isn't: a demo costs nothing`);
}

/** Puts every adapter of the copy's project.yaml on fake: each port, Jev, and each named harness. */
function fakeAll(sailDir) {
  const config = join(sailDir, 'project.yaml');
  const project = Bun.YAML.parse(readFileSync(config, 'utf8'));
  const { harnesses, ...ports } = project.adapters ?? {};
  project.adapters = Object.fromEntries(Object.keys(ports).map((port) => [port, { use: 'fake' }]));
  if (harnesses !== undefined) {
    project.adapters.harnesses = Object.fromEntries(Object.keys(harnesses).map((name) => [name, { use: 'fake' }]));
  }
  writeFileSync(config, Bun.YAML.stringify(project, null, 2));
}

/** Where each runs folder goes under `.sail-runs/`: `to` is the run's own directory, or '' for a folder of runs. */
function planRuns(folders) {
  return folders.map((folder) => {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) refuse(`--runs ${folder} is no folder`);
    const header = join(folder, 'run.json');
    if (!existsSync(header)) return { folder, to: '' };
    const runId = JSON.parse(readFileSync(header, 'utf8')).runId;
    if (typeof runId !== 'string' || !/^[\w.-]+$/.test(runId)) refuse(`${header} holds no runId`);
    return { folder, to: runId };
  });
}

/** Makes every file under `path` writable, as a copy of a read-only fixture must be; a link and what it points to stay. */
function makeWritable(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  } else chmodSync(path, 0o644);
}

function create(dir, from, own, runs) {
  if (existsSync(join(dir, 'repo'))) refuse(`${join(dir, 'repo')} exists already`);
  if (!own) checkFake(from, `${from} holds no project.yaml`);
  const seeds = planRuns(runs);
  mkdirSync(join(dir, 'repo'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  git(dir, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(dir, 'repo', 'README.md'), '# demo\n\nThe scratch repository a demonstration runs in.\n');
  // The SDK's declarations are generated where the repository is checked, not copied.
  const generated = (source) => !source.endsWith('sail.d.ts') && !source.endsWith('sail-intakes.d.ts');
  cpSync(from, join(dir, 'repo', '.sail'), { recursive: true, filter: own ? generated : undefined });
  if (own) {
    fakeAll(join(dir, 'repo', '.sail'));
    // The conventions the config lists are appended to every agent prompt, so they must exist.
    for (const name of ['AGENTS.md', 'CONTEXT.md']) cpSync(join(root, name), join(dir, 'repo', name));
  }
  for (const { folder, to } of seeds) {
    const target = join(dir, 'repo', '.sail-runs', to);
    cpSync(folder, target, { recursive: true });
    makeWritable(target);
    console.log(`demo: seeded .sail-runs/ from ${folder}`);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'demo repository');
  console.log(`demo: ${join(dir, 'repo')} holds ${from}, every port on fake; its HOME is ${join(dir, 'home')}`);
}

const quote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

/** The fake workspace copies only committed files, so seeds edited since `new` are committed first. */
function commitSeeds(dir) {
  if (git(dir, 'status', '--porcelain') !== '') {
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '-m', 'demo seeds');
  }
}

async function runIn(dir, argv) {
  // Checked again on every run: the seeds may have changed project.yaml since `new`.
  checkFake(join(dir, 'repo', '.sail'), `${dir} holds no demo repository: run \`demo.sh new ${dir}\` first`);
  commitSeeds(dir);
  const log = join(dir, `.run-${Date.now()}.log`);
  const fd = openSync(log, 'w');
  // Its own process group, so a timeout stops whatever it started too.
  const child = spawn(argv[0], argv.slice(1), {
    cwd: join(dir, 'repo'),
    env: envOf(dir),
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, TIMEOUT_SECONDS * 1000);
  const code = await new Promise((done) => {
    child.on('error', (error) => done({ error }));
    child.on('exit', (exit, signal) => done({ exit, signal }));
  });
  clearTimeout(timer);
  const output = readFileSync(log, 'utf8');
  const exit = code.error !== undefined ? 127 : (code.exit ?? 128);
  const ending = code.error
    ? `could not start: ${code.error.message}`
    : timedOut
      ? `killed after ${TIMEOUT_SECONDS}s`
      : `exit ${exit}${code.signal ? ` (${code.signal})` : ''}`;
  const entry = `$ ${argv.map(quote).join(' ')}\n${output}${output === '' || output.endsWith('\n') ? '' : '\n'}${ending}\n`;
  appendFileSync(join(dir, 'transcript.txt'), `${entry}\n`);
  const printed =
    entry.length > PRINTED ? `… (${entry.length - PRINTED} characters cut)\n${entry.slice(-PRINTED)}` : entry;
  process.stdout.write(printed);
  process.exit(exit);
}

/** The Chrome to capture with: SAIL_DEMO_CHROME, else the first one installed. */
function findChrome() {
  const named = process.env.SAIL_DEMO_CHROME;
  for (const candidate of named ? [named] : CHROMES) {
    const found = candidate.startsWith('/') ? (existsSync(candidate) ? candidate : null) : Bun.which(candidate);
    if (found !== null) return found;
  }
  return undefined;
}

/** Signals `child`'s process group, which it leads. */
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {}
}

/** Calls on one DevTools target over its WebSocket: `send(method, params)` answers with the result. */
async function devtools(url) {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error(`no DevTools connection at ${url}`));
  });
  let next = 1;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const answer = waiting.get(message.id);
    if (answer === undefined) return;
    waiting.delete(message.id);
    if (message.error) answer.fail(new Error(`${message.error.message}`));
    else answer.done(message.result);
  };
  return {
    send: (method, params = {}) =>
      new Promise((done, fail) => {
        const id = next++;
        waiting.set(id, { done, fail });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => socket.close(),
  };
}

/** Evaluates `expression` in the page and answers its value; a throw in the page becomes an Error. */
async function evaluate(session, expression) {
  const answer = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (answer.exceptionDetails !== undefined)
    throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
  return answer.result.value;
}

/**
 * Waits for the page's DOM to go SETTLE_MS without a change. A page that keeps changing for `seconds` fails, unless
 * `lenient`: a live run's page may never settle.
 */
async function settle(session, lenient, seconds = CAPTURE_SECONDS) {
  const until = Date.now() + seconds * 1000;
  let last = -1;
  let since = Date.now();
  for (;;) {
    if (Date.now() > until) {
      if (lenient) return;
      throw new Error(`the page kept changing for ${seconds}s`);
    }
    await Bun.sleep(250);
    const now = await evaluate(session, 'document.documentElement.outerHTML.length');
    if (now !== last) [last, since] = [now, Date.now()];
    else if (Date.now() - since >= SETTLE_MS) return;
  }
}

/**
 * Starts headless Chrome and opens `page` over its DevTools protocol, then waits for its DOM to settle: a screenshot
 * taken at load would show the page empty, since it draws from its sockets. A page that keeps changing fails the
 * capture, unless `lenient`: a live run's page may never settle, and the steps carry on after CAPTURE_SECONDS.
 */
async function openPage(browser, profile, page, lenient) {
  // Chrome writes the port it picked, then the browser's path, to DevToolsActivePort in its profile: a file left by
  // an earlier capture would name a port no one listens on.
  const portFile = join(profile, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--window-size=1440,900',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  );
  let ended = false;
  child.on('exit', () => {
    ended = true;
  });
  child.on('error', () => {
    ended = true;
  });
  let session;
  const close = () => {
    session?.close();
    signalGroup(child, 'SIGKILL');
  };
  try {
    const started = Date.now() + CAPTURE_SECONDS * 1000;
    while (!existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2) {
      if (Date.now() > started || ended) throw new Error(`${browser} started no DevTools`);
      await Bun.sleep(100);
    }
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((each) => each.type === 'page');
    if (target === undefined) throw new Error('Chrome opened no page');
    session = await devtools(target.webSocketDebuggerUrl);
    await session.send('Page.enable');
    await session.send('Page.navigate', { url: page });
    await settle(session, lenient);
  } catch (error) {
    close();
    throw error;
  }
  return { session, close };
}

/** Writes the screenshot to `png` and the DOM to `html`; answers a `scrolled <key> <top>` line per box scrolled down. */
async function writeShot(session, png, html) {
  const shot = await session.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(png, Buffer.from(shot.data, 'base64'));
  const dom = await evaluate(session, 'document.documentElement.outerHTML');
  writeFileSync(html, `${dom}\n`);
  const scrolled = await evaluate(
    session,
    `[...document.querySelectorAll('[data-scroll]')].filter((e) => e.scrollTop > 0).map((e) => e.getAttribute('data-scroll') + ' ' + Math.round(e.scrollTop))`,
  );
  return { characters: dom.length + 1, scrolled };
}

const SHAPES = {
  click: (step) => typeof step.click === 'string' && Object.keys(step).length === 1,
  scroll: (step) => typeof step.scroll === 'string' && Number.isFinite(step.top) && Object.keys(step).length === 2,
  wait: (step) =>
    ((typeof step.wait === 'string' && step.wait !== '') || (Number.isFinite(step.wait) && step.wait >= 0)) &&
    Object.keys(step).length === 1,
  shot: (step) => typeof step.shot === 'string' && /^[\w-]+$/.test(step.shot) && Object.keys(step).length === 1,
};

/** Reads and checks a whole steps file, so a bad one is refused before Chrome or the dashboard starts. */
function readSteps(file) {
  let steps;
  try {
    steps = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    refuse(`${file} is no steps file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(steps) || steps.length === 0) refuse(`${file} must hold a non-empty JSON list of steps`);
  const shots = new Set();
  steps.forEach((step, at) => {
    const kind =
      step !== null && typeof step === 'object' ? Object.keys(SHAPES).find((each) => each in step) : undefined;
    if (kind === undefined || !SHAPES[kind](step))
      refuse(
        `step ${at + 1} of ${file} is ${JSON.stringify(step)}: a step is {"click": css}, {"scroll": css, "top": px}, {"wait": css or ms} or {"shot": name}`,
      );
    if (kind === 'shot') {
      if (shots.has(step.shot)) refuse(`step ${at + 1} of ${file} repeats the shot name ${JSON.stringify(step.shot)}`);
      shots.add(step.shot);
    }
  });
  return steps;
}

/** Runs `steps` in order on the open page, pushing each one's transcript lines to `out`; throws at the first miss. */
async function runSteps(session, steps, dir, name, out) {
  for (const [at, step] of steps.entries()) {
    const head = `step ${at + 1} ${JSON.stringify(step)}`;
    const miss = (within = '') => new Error(`step ${at + 1} (${JSON.stringify(step)}) matched nothing${within}`);
    if ('click' in step) {
      const hit = await evaluate(
        session,
        `(() => { const e = document.querySelector(${JSON.stringify(step.click)}); if (e === null) return false; e.click(); return true; })()`,
      );
      if (!hit) throw miss();
      // The page redraws a moment after a click, so a shot straight after it would show the page before it. A live
      // run's page, redrawn each second, never settles: it is given CLICK_SECONDS.
      await settle(session, true, CLICK_SECONDS);
      out.push(`${head}: clicked`);
    } else if ('scroll' in step) {
      const top = await evaluate(
        session,
        `(() => { const e = document.querySelector(${JSON.stringify(step.scroll)}); if (e === null) return null; e.scrollTop = ${step.top}; return Math.round(e.scrollTop); })()`,
      );
      if (top === null) throw miss();
      out.push(`${head}: scrollTop ${top}`);
    } else if ('wait' in step) {
      const started = Date.now();
      if (typeof step.wait === 'number') await Bun.sleep(step.wait);
      else {
        while (!(await evaluate(session, `document.querySelector(${JSON.stringify(step.wait)}) !== null`))) {
          if (Date.now() - started > WAIT_SECONDS * 1000) throw miss(` within ${WAIT_SECONDS}s`);
          await Bun.sleep(100);
        }
      }
      out.push(`${head}: ${typeof step.wait === 'number' ? 'waited' : 'found after'} ${Date.now() - started}ms`);
    } else {
      const png = join(dir, `${name}-${step.shot}.png`);
      const html = join(dir, `${name}-${step.shot}.html`);
      const { characters, scrolled } = await writeShot(session, png, html);
      out.push(`${head}: screenshot ${png}`, `  dom ${html}, ${characters} characters`);
      for (const line of scrolled) out.push(`  scrolled ${line}`);
    }
  }
}

/** The run directories of `key` under `dir`'s .sail-runs/. */
function runsOf(dir, key) {
  const runs = join(dir, 'repo', '.sail-runs');
  return existsSync(runs) ? readdirSync(runs).filter((entry) => entry.startsWith(`${key}-`)) : [];
}

/** Starts `sail <key>` in `dir`'s repository; answers the new run's id, once its run.json is there, with a stop. */
async function startLive(dir, key) {
  commitSeeds(dir);
  const before = new Set(runsOf(dir, key));
  const log = join(dir, `.live-${Date.now()}.log`);
  const fd = openSync(log, 'w');
  const child = spawn(join(root, 'bin', 'sail'), [key], {
    cwd: join(dir, 'repo'),
    env: envOf(dir),
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  const ended = new Promise((done) => child.on('exit', done));
  let over = false;
  ended.then(() => {
    over = true;
  });
  // Interrupted, the run suspends; one that doesn't leave within 15s is killed.
  const stop = async () => {
    if (over) return;
    signalGroup(child, 'SIGINT');
    const killer = setTimeout(() => signalGroup(child, 'SIGKILL'), 15000);
    await ended;
    clearTimeout(killer);
  };
  process.on('exit', () => signalGroup(child, 'SIGKILL'));
  const until = Date.now() + 30000;
  for (;;) {
    const id = runsOf(dir, key).find(
      (each) => !before.has(each) && existsSync(join(dir, 'repo', '.sail-runs', each, 'run.json')),
    );
    if (id !== undefined) return { id, log, stop };
    if (over || Date.now() > until) {
      await stop();
      refuse(`sail ${key} started no run:\n${readFileSync(log, 'utf8').slice(-2000)}`);
    }
    await Bun.sleep(100);
  }
}

async function capture(dir, name, query, stepsFile, steps, live) {
  checkFake(join(dir, 'repo', '.sail'), `${dir} holds no demo repository: run \`demo.sh new ${dir}\` first`);
  if (!/^[\w-]+$/.test(name)) refuse(`a capture's name is letters, digits, - and _, not ${name}`);
  const browser = findChrome();
  if (browser === undefined)
    refuse('no Chrome to capture the dashboard with: install Chrome, or name it in SAIL_DEMO_CHROME');
  let run;
  if (live !== undefined) {
    run = await startLive(dir, live);
    if (!query.has('run')) query.set('run', run.id);
    if (!query.has('repo'))
      query.set('repo', Bun.YAML.parse(readFileSync(join(dir, 'repo', '.sail', 'project.yaml'), 'utf8')).name);
  }
  const server = spawn(join(root, 'bin', 'sail'), ['dashboard', '--port', '0'], {
    cwd: join(dir, 'repo'),
    env: envOf(dir),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const stopped = new Promise((done) => server.on('exit', done));
  // Stopped on every way out: a refusal exits the process, so the exit hook stops it too.
  const stop = () => signalGroup(server, 'SIGINT');
  process.on('exit', stop);
  let printed = '';
  try {
    const url = await new Promise((done) => {
      const timer = setTimeout(() => done(undefined), 30000);
      const read = (chunk) => {
        printed += chunk;
        const found = /http:\/\/127\.0\.0\.1:\d+/.exec(printed);
        if (found !== null) {
          clearTimeout(timer);
          done(found[0]);
        }
      };
      server.stdout.on('data', read);
      server.stderr.on('data', read);
      stopped.then(() => done(undefined));
    });
    if (url === undefined) refuse(`sail dashboard didn't start:\n${printed}`);
    const page = `${url}/${query.size === 0 ? '' : `?${query}`}`;
    const lines = [];
    let work;
    try {
      const opened = await Promise.race([
        openPage(browser, join(dir, 'chrome'), page, steps !== undefined),
        new Promise((_, fail) =>
          setTimeout(() => fail(new Error(`no capture in ${TIMEOUT_SECONDS}s`)), TIMEOUT_SECONDS * 1000).unref(),
        ),
      ]);
      work = opened;
      if (steps === undefined) {
        const png = join(dir, `${name}.png`);
        const html = join(dir, `${name}.html`);
        const { characters } = await writeShot(opened.session, png, html);
        lines.push(`screenshot ${png}`, `dom ${html}, ${characters} characters`);
      } else {
        await Promise.race([
          runSteps(opened.session, steps, dir, name, lines),
          new Promise((_, fail) =>
            setTimeout(() => fail(new Error(`steps took over ${TIMEOUT_SECONDS}s`)), TIMEOUT_SECONDS * 1000).unref(),
          ),
        ]);
      }
    } catch (error) {
      lines.push(`no capture: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      work?.close();
    }
    if (run !== undefined) {
      await run.stop();
      const status = readFileSync(join(dir, 'repo', '.sail-runs', run.id, 'STATUS'), 'utf8').split('\n')[0];
      lines.push(`live ${run.id}: ${status}`, `log ${run.log}`);
    }
    const ending = lines.join('\n');
    const entry = `$ dashboard ${page}${stepsFile === undefined ? '' : ` steps=${stepsFile}`}\n${ending}\n`;
    appendFileSync(join(dir, 'transcript.txt'), `${entry}\n`);
    process.stdout.write(entry);
    return lines.some((line) => line.startsWith('no capture')) ? 1 : 0;
  } finally {
    await run?.stop();
    stop();
    const killer = setTimeout(() => signalGroup(server, 'SIGKILL'), 5000);
    await stopped;
    clearTimeout(killer);
    process.off('exit', stop);
  }
}

const [command, target, ...rest] = process.argv.slice(2);
if (target === undefined)
  refuse(
    'usage: demo.sh new <dir> [--from <sail-dir> | --own] [--runs <folder>]… | run <dir> sail [args…] | dashboard <dir> <name> [<k>=<v>…]',
  );
const dir = resolve(target);
if (command === 'new') {
  const usage = 'usage: demo.sh new <dir> [--from <sail-dir> | --own] [--runs <folder>]…';
  let own = false;
  let from;
  const runs = [];
  for (let at = 0; at < rest.length; at++) {
    if (rest[at] === '--own' && !own && from === undefined) own = true;
    else if (rest[at] === '--from' && !own && from === undefined && rest[at + 1] !== undefined) from = rest[++at];
    else if (rest[at] === '--runs' && rest[at + 1] !== undefined) runs.push(resolve(rest[++at]));
    else refuse(usage);
  }
  create(dir, own ? join(root, '.sail') : resolve(from ?? FIXTURE_SAIL), own, runs);
} else if (command === 'run') {
  if (rest[0] !== 'sail') refuse('usage: demo.sh run <dir> sail [args…]: only sail runs here');
  await runIn(dir, rest);
} else if (command === 'dashboard') {
  const [name, ...picks] = rest;
  if (name === undefined) refuse('usage: demo.sh dashboard <dir> <name> [repo=… run=… key=… tab=… steps=… live=…]');
  const query = new URLSearchParams();
  let stepsFile;
  let live;
  for (const pick of picks) {
    const [, field, value] = /^(repo|run|key|tab|steps|live)=(.+)$/.exec(pick) ?? [];
    if (field === undefined) refuse(`${pick} picks nothing: repo=, run=, key=, tab=, steps= or live=`);
    if (field === 'steps') stepsFile = resolve(value);
    else if (field === 'live') {
      if (!/^[A-Z][A-Z0-9]*-\d+$/.test(value)) refuse(`live= takes a ticket key such as FAKE-1, not ${value}`);
      live = value;
    } else query.set(field, value);
  }
  const steps = stepsFile === undefined ? undefined : readSteps(stepsFile);
  process.exit(await capture(dir, name, query, stepsFile, steps, live));
} else {
  refuse(`no command ${command}: new, run or dashboard`);
}
