// `sail init`: writes a repository's `.sail/` in the directory it is run from: a config with every port on its fake, a
// `tsconfig.json` under sail's house rules, and the two editor declarations. It adds three lines to `.gitignore`: the
// runs, and the declarations, which name this machine. It writes no workflow and no stage, not even as an example:
// what a repository runs is its own to write (ADR-0016). `sail check` passes on what it leaves.
//
// It refuses, with exit code 3 and nothing written, outside a git repository, in the home directory, whose `.sail/` is
// sail's own, and where a `.sail` exists as anything: it never touches one. `.sail/` is built beside its place and
// renamed into it, so a failure leaves none. `.gitignore` is read before anything is written, and written after, by a
// rename too: a write that fails leaves the lines it held.
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import pkg from '../../../package.json' with { type: 'json' };
import { editorDeclarations } from '../../engine/editor';
import { render } from '../../engine/render';
import { findGitRoot } from '../../engine/sail-dir';
import { EXIT_OK, type ExitCode } from '../exit-codes';
import type { Io } from '../index';
import { refuseAs } from './run-workflow';

const COMMAND = 'sail init';
/** The files `.sail/` starts from, which ship inside sail. */
const BUILTIN = join(import.meta.dir, '..', '..', 'builtins', 'init');
/** What git must ignore: the runs, and the editor declarations, which name this machine. */
const IGNORED = ['.sail-runs/', '.sail/sail.d.ts', '.sail/sail-intakes.d.ts'];

/**
 * A directory's name as the config's `name`: lower-cased, each run of characters outside `a-z0-9` a `-`, with no `-`
 * at either end, and `repository` when nothing is left.
 */
export function slugOf(directory: string): string {
  const slug = directory
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug === '' ? 'repository' : slug;
}

/** The designation label a repository named `name` starts with. */
export const labelOf = (name: string): string => `sail-${name}`;

/** The sail versions a `.sail/` written by `version` accepts: from it up to its next major. */
export function rangeOf(version: string): string {
  return `>=${version} <${Number(version.split('.')[0]) + 1}`;
}

/** Whether anything is at `path`: a file, a directory, or a link to nothing. */
function exists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

/** Whether `directory` is the home directory: `HOME` when the environment sets it, the system's otherwise. */
function isHome(directory: string, io: Io): boolean {
  const home = (io.env ?? process.env).HOME || homedir();
  try {
    return realpathSync(directory) === realpathSync(home);
  } catch {
    return false;
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * `.gitignore` as it should read: `text` with each line of `IGNORED` it lacks, after a newline if its last line has
 * none. A file with CRLF line endings holds a line whatever ends it, and gains lines that end as its own do.
 */
function ignoring(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const missing = IGNORED.filter((line) => !lines.includes(line));
  if (missing.length === 0) return text;
  return `${text}${text === '' || text.endsWith('\n') ? '' : eol}${missing.map((line) => `${line}${eol}`).join('')}`;
}

/**
 * Makes the file at `path` hold `text`, by a rename: it is written beside its place first, so a write that fails half
 * way leaves what was there. An existing file keeps its mode, a link stays a link to the file that changed, and one
 * that can't be written is refused before anything is.
 */
function replaceFile(path: string, text: string): void {
  const existing = exists(path);
  const target = existing ? realpathSync(path) : path;
  if (existing) accessSync(target, constants.W_OK);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text);
    if (existing) chmodSync(temporary, statSync(target).mode & 0o777);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function init(_args: unknown, io: Io): ExitCode {
  const refuse = refuseAs(io, COMMAND);
  const here = io.cwd;
  if (findGitRoot(here) === undefined) return refuse(`not inside a git repository: ${here}`);
  if (isHome(here, io)) return refuse(`${here} is the home directory, whose .sail/ is sail's own`);
  const sail = join(here, '.sail');
  if (exists(sail)) return refuse('.sail/ already exists here, and sail init never overwrites one');

  const gitignore = join(here, '.gitignore');
  let ignored: string | undefined;
  try {
    if (exists(gitignore)) ignored = readFileSync(gitignore, 'utf8');
  } catch (error) {
    return refuse(`could not read .gitignore: ${messageOf(error)}`);
  }

  const name = slugOf(basename(here));
  const files = [
    {
      name: 'project.yaml',
      text: render(readFileSync(join(BUILTIN, 'project.yaml'), 'utf8'), {
        name,
        label: labelOf(name),
        sail: rangeOf(pkg.version),
      }).text,
    },
    { name: 'tsconfig.json', text: readFileSync(join(BUILTIN, 'tsconfig.json'), 'utf8') },
    ...editorDeclarations(),
  ];
  // Built beside its place and renamed into it: whatever fails on the way, no `.sail/` is left half-written.
  let building: string | undefined;
  try {
    building = mkdtempSync(join(here, '.sail.init-'));
    // A temporary directory is its owner's alone. `.sail/` is a directory like any other in the repository.
    chmodSync(building, 0o777 & ~process.umask());
    for (const file of files) writeFileSync(join(building, file.name), file.text);
    renameSync(building, sail);
  } catch (error) {
    if (building !== undefined) rmSync(building, { recursive: true, force: true });
    return refuse(`could not write .sail/: ${messageOf(error)}`);
  }
  for (const file of files) io.stdout(`wrote .sail/${file.name}\n`);

  const wanted = ignoring(ignored ?? '');
  if (wanted !== ignored) {
    try {
      replaceFile(gitignore, wanted);
    } catch (error) {
      // `.sail/` is in place by now, and the next `sail init` would refuse: say so.
      return refuse(`.sail/ is written, but .gitignore could not be: ${messageOf(error)}`);
    }
    io.stdout(ignored === undefined ? 'wrote .gitignore\n' : 'updated .gitignore\n');
  }
  io.stdout(
    'next: set name and label in .sail/project.yaml, write a workflow under .sail/workflows/, then run sail check\n',
  );
  return EXIT_OK;
}
