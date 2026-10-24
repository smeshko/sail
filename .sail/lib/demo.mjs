// The demo harness: a scratch repository with every port on `fake`, and this checkout's sail run in it with a clean
// environment, so a stage can show a change working at runtime at $0. Nothing it does writes to the checkout.
// Usage: bun .sail/lib/demo.mjs <command> …, or .sail/lib/demo.sh <command> …
//   new <dir> [--from <sail-dir>]  a git repository at <dir>/repo holding a copy of <sail-dir>, the fixture
//                                  repository's .sail/ when left out, and the HOME its commands get, at <dir>/home
//   run <dir> <command> [args…]    commits what changed in <dir>/repo, runs the command there with this checkout's
//                                  sail first on its PATH, prints what it printed and appends it to
//                                  <dir>/transcript.txt; exits with the command's code
// The environment a command gets is built from nothing: no SAIL_CONFIG, SAIL_EVENTS or SAIL_BUN from a step around
// it, no keys, and a HOME, SAIL_HOME and git identity of its own. A repository whose ports aren't all fake is refused.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..', '..');
const FIXTURE_SAIL = join(root, 'test', 'fixtures', 'repo', '.sail');
const PORTS = ['ticketSource', 'codeHost', 'harness', 'workspace'];
const TIMEOUT_SECONDS = 300;
const PRINTED = 20000;

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

function create(dir, from) {
  if (existsSync(join(dir, 'repo'))) refuse(`${join(dir, 'repo')} exists already`);
  checkFake(from, `${from} holds no project.yaml`);
  mkdirSync(join(dir, 'repo'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  git(dir, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(dir, 'repo', 'README.md'), '# demo\n\nThe scratch repository a demonstration runs in.\n');
  cpSync(from, join(dir, 'repo', '.sail'), { recursive: true });
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

const [command, target, ...rest] = process.argv.slice(2);
if (target === undefined) refuse('usage: demo.sh new <dir> [--from <sail-dir>] | demo.sh run <dir> <command> [args…]');
const dir = resolve(target);
if (command === 'new') {
  if (rest.length !== 0 && (rest.length !== 2 || rest[0] !== '--from'))
    refuse('usage: demo.sh new <dir> [--from <sail-dir>]');
  create(dir, resolve(rest[1] ?? FIXTURE_SAIL));
} else if (command === 'run') {
  if (rest.length === 0) refuse('usage: demo.sh run <dir> <command> [args…]');
  await runIn(dir, rest);
} else {
  refuse(`no command ${command}: new or run`);
}
