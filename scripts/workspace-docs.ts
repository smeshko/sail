// A run's workspace is a detached worktree of origin/<default>, which lacks the clone's gitignored docs/ (ADRs, plans,
// epics). The workspace setup runs this to copy the Markdown under the clone's docs/ into the workspace's docs/, so
// agents can read it. The copy is real files and never reaches git, which ignores docs/.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The clone a workspace's worktree belongs to: the parent of its git common dir. */
export function cloneOf(workspace: string, env?: Readonly<Record<string, string>>): string {
  const result = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: workspace,
    ...(env === undefined ? {} : { env }),
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return dirname(resolve(workspace, result.stdout.toString().trim()));
}

/** Copies the clone's `docs/**\/*.md` to the workspace's `docs/`, never over a file there. Returns the relative paths copied, sorted. */
export function copyDocs(clone: string, workspace: string): string[] {
  const source = join(clone, 'docs');
  if (resolve(clone) === resolve(workspace) || !existsSync(source) || !statSync(source).isDirectory()) return [];
  const copied: string[] = [];
  const files = new Bun.Glob('**/*.md').scanSync({ cwd: source, onlyFiles: true, followSymlinks: false });
  for (const relative of [...files].sort()) {
    const target = join(workspace, 'docs', relative);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, relative), target);
    copied.push(relative);
  }
  return copied;
}

if (import.meta.main) {
  try {
    const clone = cloneOf(process.cwd());
    const copied = copyDocs(clone, process.cwd());
    console.log(`workspace-docs: copied ${copied.length} files from ${join(clone, 'docs')}`);
  } catch (error) {
    console.error(`workspace-docs: ${(error as Error).message}`);
    process.exit(1);
  }
}
