// A run's directories laid out on disk for the permission engine's tests, the way ADR-0018 places them: the worktree and
// the call directory both under the clone's .sail-runs/, so the clone's own checkout is an ancestor of both.
//
//   <root>/clone/lib/a.dart                          the clone's own checkout
//   <root>/clone/.sail-runs/r1/worktree/             the run's worktree: src/a.ts, src/deep/, sub/, lib/
//   <root>/clone/.sail-runs/r1/01-spec/call-1/       $STAGE_OUT
//   <root>/clone/.sail-runs/r1/01-spec/call-1/in/    $STAGE_IN, with brief.md
//   <root>/elsewhere/                                outside everything
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DecideContext } from '../../src/engine/permissions/types';
import type { Permissions } from '../../src/sdk/steps';

export interface Layout {
  readonly root: string;
  readonly clone: string;
  readonly worktree: string;
  readonly stageOut: string;
  readonly stageIn: string;
  readonly elsewhere: string;
  readonly ctx: DecideContext;
  /** Creates an empty file, and its directories, at `path` (absolute, or relative to the worktree). */
  file(path: string): string;
  /** Creates a symbolic link at `path` (relative to the worktree) pointing at `target`, as written. */
  link(path: string, target: string): string;
  remove(): void;
}

export function makeLayout(): Layout {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sail-permissions-')));
  const clone = join(root, 'clone');
  const worktree = join(clone, '.sail-runs', 'r1', 'worktree');
  const stageOut = join(clone, '.sail-runs', 'r1', '01-spec', 'call-1');
  const stageIn = join(stageOut, 'in');
  const elsewhere = join(root, 'elsewhere');
  const at = (path: string): string => (path.startsWith('/') ? path : join(worktree, path));
  const file = (path: string): string => {
    const full = at(path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, '');
    return full;
  };
  for (const dir of [join(worktree, 'src', 'deep'), join(worktree, 'sub'), join(worktree, 'lib'), stageIn, elsewhere]) {
    mkdirSync(dir, { recursive: true });
  }
  file(join(clone, 'lib', 'a.dart'));
  file('src/a.ts');
  file('lib/a.dart');
  file(join(stageIn, 'brief.md'));
  const env = { STAGE_OUT: stageOut, STAGE_IN: stageIn, WORKSPACE: worktree, RUN_ID: 'r1', STAGE: 'spec' };
  return {
    root,
    clone,
    worktree,
    stageOut,
    stageIn,
    elsewhere,
    ctx: { worktree, stageOut, stageIn, env },
    file,
    link: (path, target) => {
      const full = at(path);
      mkdirSync(dirname(full), { recursive: true });
      symlinkSync(target, full);
      return full;
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Permissions with nothing open but what `open` gives. */
export function perms(open: Partial<Permissions> = {}): Permissions {
  return { read: [], write: [], commands: [], ...open };
}
