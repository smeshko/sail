// The demo harness: a scratch repository with every port on `fake`, and this checkout's sail run in it with a clean
// environment, so a stage can show a change working at runtime at $0. Nothing it does writes to the checkout.
// Usage: bun .sail/lib/demo.mjs <command> …, or .sail/lib/demo.sh <command> …
//   new <dir> [--from <sail-dir>]  a git repository at <dir>/repo holding a copy of <sail-dir>, the fixture
//                                  repository's .sail/ when left out, and the HOME its commands get, at <dir>/home
//   new <dir> --own                the same, holding this checkout's own .sail/ with every adapter put on fake, its
//                                  seeds the ones under .sail/fake/
//   run <dir> sail [args…]         commits what changed in <dir>/repo, runs this checkout's sail there, prints what
//                                  it printed and appends it to <dir>/transcript.txt; exits with sail's code. Only
//                                  sail runs, so a stage allowed this harness runs nothing else through it
//   dashboard <dir> <name> [repo=… run=… key=… tab=…]
//                                  serves <dir>'s runs with this checkout's `sail dashboard`, opens it in headless
//                                  Chrome on the run, call and tab named, writes what Chrome drew to <dir>/<name>.png
//                                  and the page's DOM to <dir>/<name>.html, and stops the dashboard whatever happens.
//                                  Each selection is a word of its own, not a query: a command gate reads a quoted
//                                  `&` as a background job. Chrome is found where it installs, or named by
//                                  SAIL_DEMO_CHROME
// The environment a command gets is built from nothing: no SAIL_CONFIG, SAIL_EVENTS or SAIL_BUN from a step around
// it, no keys, and a HOME, SAIL_HOME and git identity of its own. A repository whose ports aren't all fake is refused.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/** How long a capture may take in all, Chrome's start included. */
const CAPTURE_SECONDS = 60;

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

function create(dir, from, own) {
  if (existsSync(join(dir, 'repo'))) refuse(`${join(dir, 'repo')} exists already`);
  if (!own) checkFake(from, `${from} holds no project.yaml`);
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
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'demo repository');
  console.log(`demo: ${join(dir, 'repo')} holds ${from}, every port on fake; its HOME is ${join(dir, 'home')}`);
}

const quote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

async function runIn(dir, argv) {
  // Checked again on every run: the seeds may have changed project.yaml since `new`.
  checkFake(join(dir, 'repo', '.sail'), `${dir} holds no demo repository: run \`demo.sh new ${dir}\` first`);
  // The fake workspace copies only committed files, so seeds edited since `new` are committed first.
  if (git(dir, 'status', '--porcelain') !== '') {
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '-m', 'demo seeds');
  }
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

/**
 * Opens `page` in headless Chrome over its DevTools protocol, waits for its DOM to settle, and writes the screenshot
 * to `png` and the DOM to `html`. A screenshot taken at load would show the page empty: it draws from its sockets.
 */
async function shoot(browser, profile, page, png, html) {
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
  const until = Date.now() + CAPTURE_SECONDS * 1000;
  const late = () => Date.now() > until;
  let session;
  try {
    while (!existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2) {
      if (late() || ended) throw new Error(`${browser} started no DevTools`);
      await Bun.sleep(100);
    }
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((each) => each.type === 'page');
    if (target === undefined) throw new Error('Chrome opened no page');
    session = await devtools(target.webSocketDebuggerUrl);
    await session.send('Page.enable');
    await session.send('Page.navigate', { url: page });
    const size = async () =>
      (await session.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML.length' })).result
        .value;
    let last = -1;
    let since = Date.now();
    for (;;) {
      if (late()) throw new Error(`the page kept changing for ${CAPTURE_SECONDS}s`);
      await Bun.sleep(250);
      const now = await size();
      if (now !== last) [last, since] = [now, Date.now()];
      else if (Date.now() - since >= SETTLE_MS) break;
    }
    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(png, Buffer.from(shot.data, 'base64'));
    const dom = await session.send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    });
    writeFileSync(html, `${dom.result.value}\n`);
  } finally {
    session?.close();
    signalGroup(child, 'SIGKILL');
  }
}

async function capture(dir, name, query) {
  checkFake(join(dir, 'repo', '.sail'), `${dir} holds no demo repository: run \`demo.sh new ${dir}\` first`);
  if (!/^[\w-]+$/.test(name)) refuse(`a capture's name is letters, digits, - and _, not ${name}`);
  const browser = findChrome();
  if (browser === undefined)
    refuse('no Chrome to capture the dashboard with: install Chrome, or name it in SAIL_DEMO_CHROME');
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
    const page = `${url}/${query === '' ? '' : `?${query}`}`;
    const png = join(dir, `${name}.png`);
    const html = join(dir, `${name}.html`);
    let ending;
    try {
      await shoot(browser, join(dir, 'chrome'), page, png, html);
      ending = `screenshot ${png}\ndom ${html}, ${readFileSync(html, 'utf8').length} characters`;
    } catch (error) {
      ending = `no capture: ${error instanceof Error ? error.message : String(error)}`;
    }
    const entry = `$ dashboard ${page}\n${ending}\n`;
    appendFileSync(join(dir, 'transcript.txt'), `${entry}\n`);
    process.stdout.write(entry);
    return ending.startsWith('no capture') ? 1 : 0;
  } finally {
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
    'usage: demo.sh new <dir> [--from <sail-dir> | --own] | run <dir> sail [args…] | dashboard <dir> <name> [<k>=<v>…]',
  );
const dir = resolve(target);
if (command === 'new') {
  const own = rest.length === 1 && rest[0] === '--own';
  if (rest.length !== 0 && !own && (rest.length !== 2 || rest[0] !== '--from'))
    refuse('usage: demo.sh new <dir> [--from <sail-dir> | --own]');
  create(dir, own ? join(root, '.sail') : resolve(rest[1] ?? FIXTURE_SAIL), own);
} else if (command === 'run') {
  if (rest[0] !== 'sail') refuse('usage: demo.sh run <dir> sail [args…]: only sail runs here');
  await runIn(dir, rest);
} else if (command === 'dashboard') {
  const [name, ...picks] = rest;
  if (name === undefined) refuse('usage: demo.sh dashboard <dir> <name> [repo=… run=… key=… tab=…]');
  const query = new URLSearchParams();
  for (const pick of picks) {
    const [, field, value] = /^(repo|run|key|tab)=(.+)$/.exec(pick) ?? [];
    if (field === undefined) refuse(`${pick} picks nothing: repo=, run=, key= or tab=`);
    query.set(field, value);
  }
  process.exit(await capture(dir, name, query.toString()));
} else {
  refuse(`no command ${command}: new, run or dashboard`);
}
