// installTarball(): installs a packed tarball into `<dir>/node_modules` the way a package manager would, without the
// network. It extracts the package, links its bins into node_modules/.bin, and symlinks the closure of its dependencies
// from another checkout's node_modules. Only that closure is linked, so a runtime import of a package missing from
// `dependencies` fails in the installed copy, as it would for a user, though the checkout has it as a dev dependency.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Installed {
  /** The installed package: `<dir>/node_modules/<name>`. */
  root: string;
  /** `<dir>/node_modules/.bin`, where each of the package's bins is linked. */
  bin: string;
  name: string;
  version: string;
}

interface Manifest {
  name: string;
  version: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const readManifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;

/** Finds `name` the way Node does: `node_modules/<name>` in `from` and then in each ancestor. */
function locate(name: string, from: string): string | undefined {
  for (let at = from; ; at = dirname(at)) {
    const candidate = join(at, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(at) === at) return undefined;
  }
}

/** Installs `tarball` into `dir`, linking its dependencies from `from`'s node_modules. Throws on a missing dependency. */
export function installTarball(tarball: string, dir: string, from: string): Installed {
  const staging = join(dir, '.staging');
  mkdirSync(staging, { recursive: true });
  const extract = Bun.spawnSync(['tar', '-xzf', tarball, '-C', staging]);
  if (extract.exitCode !== 0) throw new Error(`tar -xzf ${tarball} exited ${extract.exitCode}: ${extract.stderr}`);

  const manifest = readManifest(join(staging, 'package'));
  const modules = join(dir, 'node_modules');
  const root = join(modules, manifest.name);
  mkdirSync(dirname(root), { recursive: true });
  renameSync(join(staging, 'package'), root);

  const linked = new Set<string>();
  const link = (deps: Record<string, string> | undefined, at: string, required: boolean): void => {
    for (const name of Object.keys(deps ?? {})) {
      if (linked.has(name)) continue;
      const found = locate(name, at);
      if (found === undefined) {
        if (required) throw new Error(`dependency ${name} is not installed in ${from}`);
        continue;
      }
      linked.add(name);
      mkdirSync(dirname(join(modules, name)), { recursive: true });
      symlinkSync(realpathSync(found), join(modules, name));
      const dep = readManifest(found);
      link(dep.dependencies, found, true);
      link(dep.optionalDependencies, found, false);
      link(dep.peerDependencies, found, false);
    }
  };
  link(manifest.dependencies, from, true);
  link(manifest.optionalDependencies, from, false);
  link(manifest.peerDependencies, from, false);

  const bin = join(modules, '.bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, file] of Object.entries(manifest.bin ?? {})) symlinkSync(join(root, file), join(bin, name));
  return { root, bin, name: manifest.name, version: manifest.version };
}
