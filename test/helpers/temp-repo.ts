// withTempRepo(): a throwaway git repository with its own HOME, removed afterwards even when the test throws.
// Bun spawns inherit the startup environment, not a mutated process.env, so a test must pass `repo.env` to every
// subprocess it starts. process.env itself is never touched.
//
// It runs only in a process scripts/test.ts started, by the check test/setup.ts makes. A plain script keeps the real
// HOME, and a sail run in process finds its machine directory through that HOME, not repo.env's: it would record the
// repository in the real watcher registry, and the entry would outlive the repository.
//
// Every repository is a copy of one template, made once per test process under the launcher's throwaway HOME: git init,
// README.md and the commit cost three git spawns, and copying the template costs none. So every temp repository starts
// at the same commit.
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempRepo {
  /** Realpath of the repository root: `git init -b main`, one commit. */
  readonly dir: string;
  /** This call's HOME: empty, a sibling of `dir`, never inside it. */
  readonly home: string;
  /** Environment for every subprocess the test spawns. Bun spawns ignore a mutated `process.env`. */
  readonly env: Readonly<Record<string, string>>;
  /** Runs git in `dir` with `env`. Returns trimmed stdout; throws with stderr on a non-zero exit. */
  git(...args: string[]): string;
}

/** Runs git in `cwd` with `env`. Returns trimmed stdout; throws with stderr on a non-zero exit. */
function runGit(cwd: string, env: Readonly<Record<string, string>>, args: readonly string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

let template: string | undefined;
/** The repository every temp repository copies: `git init -b main` and one commit of README.md, made on first use. */
function templateRepo(env: Readonly<Record<string, string>>): string {
  if (template !== undefined && existsSync(template)) return template;
  const parent = process.env.SAIL_TEST_HOME ?? tmpdir();
  const dir = join(realpathSync(mkdtempSync(join(parent, 'sail-repo-template-'))), 'repo');
  mkdirSync(dir);
  runGit(dir, env, ['init', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGit(dir, env, ['add', 'README.md']);
  // A commit may start git's maintenance in the background, whose lock files come and go while the copy reads the
  // template: each test file makes its own template, so the copy follows the commit at once.
  runGit(dir, env, ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'commit', '-m', 'initial']);
  template = dir;
  return dir;
}

export async function withTempRepo<T>(fn: (repo: TempRepo) => T | Promise<T>): Promise<T> {
  if (process.env.SAIL_TEST_HOME !== homedir()) {
    throw new Error(
      'withTempRepo: call it from a test file run with `bun run test <file>` (in a plain script, a sail run in its repository would register that repository in your real ~/.sail/watchers/)',
    );
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sail-repo-')));
  try {
    // HOME is a sibling of the repository, so a test that chdirs into `dir` never mistakes ~/.sail for its .sail/.
    const dir = join(root, 'repo');
    const home = join(root, 'home');
    mkdirSync(home);

    // The launcher has already isolated process.env (git identity, GIT_CONFIG_NOSYSTEM); only HOME moves per call.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.HOME = home;
    env.XDG_CONFIG_HOME = join(home, '.config');

    cpSync(templateRepo(env), dir, { recursive: true });
    const git = (...args: string[]): string => runGit(dir, env, args);
    return await fn({ dir, home, env, git });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
