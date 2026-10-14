// withOrigin(): gives a temp repository a local bare `origin`, as a clone of a hosted repository has one. The bare
// repository sits beside the temp repository, inside the same throwaway root, so nothing outlives the test. Every git
// call gets `repo.env`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TempRepo } from './temp-repo';

export interface Origin {
  /** The bare repository's path: what `git remote get-url origin` gives. */
  readonly url: string;
  /** Adds a commit that writes `file` to the origin's `main`, through a second clone, and returns its sha. */
  push(file: string, content?: string): string;
}

/** Runs git in `cwd` with `env`, and throws with its stderr when it fails. */
function git(cwd: string, env: Readonly<Record<string, string>>, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env, stdin: 'ignore' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

/**
 * Makes `<root>/origin.git`, pushes `main` to it, sets it as `origin` and points `origin/HEAD` at `main`. `name` keeps
 * two origins of one root apart.
 */
export function withOrigin(repo: TempRepo, name = 'origin'): Origin {
  const root = dirname(repo.dir);
  const url = join(root, `${name}.git`);
  git(root, repo.env, 'init', '--quiet', '--bare', '-b', 'main', url);
  git(repo.dir, repo.env, 'remote', 'add', name, url);
  git(repo.dir, repo.env, 'push', '--quiet', name, 'main');
  git(repo.dir, repo.env, 'remote', 'set-head', name, 'main');
  const pusher = join(root, `${name}-pusher`);
  return {
    url,
    push(file, content = `${file}\n`) {
      if (!existsSync(pusher)) git(root, repo.env, 'clone', '--quiet', url, pusher);
      else git(pusher, repo.env, 'pull', '--quiet', '--ff-only');
      mkdirSync(dirname(join(pusher, file)), { recursive: true });
      writeFileSync(join(pusher, file), content);
      git(pusher, repo.env, 'add', file);
      git(pusher, repo.env, 'commit', '--quiet', '-m', `add ${file}`);
      git(pusher, repo.env, 'push', '--quiet', 'origin', 'HEAD:main');
      return git(pusher, repo.env, 'rev-parse', 'HEAD');
    },
  };
}
