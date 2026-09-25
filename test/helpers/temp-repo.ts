// withTempRepo(): a throwaway git repository with its own HOME, removed afterwards even when the test throws.
// Bun spawns inherit the startup environment, not a mutated process.env, so a test must pass `repo.env` to every
// subprocess it starts. process.env itself is never touched.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

export async function withTempRepo<T>(fn: (repo: TempRepo) => T | Promise<T>): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sail-repo-')));
  try {
    // HOME is a sibling of the repository, so a test that chdirs into `dir` never mistakes ~/.sail for its .sail/.
    const dir = join(root, 'repo');
    const home = join(root, 'home');
    mkdirSync(dir);
    mkdirSync(home);

    // The launcher has already isolated process.env (git identity, GIT_CONFIG_NOSYSTEM); only HOME moves per call.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.HOME = home;
    env.XDG_CONFIG_HOME = join(home, '.config');

    const git = (...args: string[]): string => {
      const result = Bun.spawnSync(['git', ...args], { cwd: dir, env });
      if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr.toString().trim()}`);
      }
      return result.stdout.toString().trim();
    };

    git('init', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), '# test repo\n');
    git('add', 'README.md');
    git('commit', '-m', 'initial');

    return await fn({ dir, home, env, git });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
