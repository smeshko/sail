// Packs the package from the files git doesn't ignore. The checkout's README.md is ignored because it names internal
// work, and `bun pm pack` packs a README.md whatever .gitignore and `files` say. So the pack copies git's file set into
// a temp directory and packs there: an ignored file can't reach the tarball, whichever checkout runs this.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const checkout = join(import.meta.dir, '..');

async function run(cmd: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** Packs `root` (default: this checkout) into `outDir` from the files git knows about, and returns the tarball's path. */
export async function packSail(options: { root?: string; outDir: string }): Promise<string> {
  const root = resolve(options.root ?? checkout);
  const outDir = resolve(options.outDir);

  // Tracked files plus new files not yet added, minus everything ignored.
  const listed = await run(['git', '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
  if (listed.code !== 0) throw new Error(`git ls-files exited ${listed.code} in ${root}: ${listed.stderr.trim()}`);
  // A file deleted from the worktree is still in the index.
  const files = listed.stdout.split('\0').filter((path) => path !== '' && existsSync(join(root, path)));
  // A copy follows a link, so a link, or a tracked path under a directory that became one, would pack its target's
  // bytes: an ignored file among them. A path must resolve to itself.
  const real = realpathSync(root);
  for (const path of files) {
    if (realpathSync(join(root, path)) !== join(real, path)) {
      throw new Error(`${path} is a symbolic link or under one, and the pack never copies a link`);
    }
  }

  const staging = realpathSync(mkdtempSync(join(tmpdir(), 'sail-pack-')));
  try {
    for (const path of files) {
      mkdirSync(dirname(join(staging, path)), { recursive: true });
      copyFileSync(join(root, path), join(staging, path)); // keeps the mode, so bin/sail stays executable
    }
    const packed = await run(
      [process.execPath, 'pm', 'pack', '--ignore-scripts', '--quiet', '--destination', outDir],
      staging,
    );
    if (packed.code !== 0) throw new Error(`bun pm pack exited ${packed.code}:\n${packed.stdout}${packed.stderr}`);
    return resolve(staging, packed.stdout.trim()); // --quiet prints the tarball path
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  console.log(await packSail({ outDir: checkout }));
}
