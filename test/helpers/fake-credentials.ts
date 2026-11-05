// fakeCredentialTools(): stand-ins for macOS's `security` and for `gh`, as executables in a directory a test puts on a
// PATH. `security find-generic-password -s <item> -w` answers from `items`, exits 44 for an item it lacks, or exits
// `refuse.code` with `refuse.stderr` for every item. `gh auth token` prints `ghToken`, or exits 1 when there is none.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeCredentialTools {
  /** Keychain items by name. */
  items?: Record<string, string>;
  /** A keychain that refuses every item. */
  refuse?: { code: number; stderr: string };
  /** What `gh auth token` prints. Left out, `gh` exits 1. */
  ghToken?: string;
  /** A `gh` that isn't there: one that exits 127, so a real `gh` later on the PATH is never reached. */
  noGh?: boolean;
}

const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** Writes the tools under `dir/tools` and returns a PATH that has them first, then the test's own `path`. */
export function fakeCredentialTools(dir: string, tools: FakeCredentialTools, path = process.env.PATH ?? ''): string {
  const bin = join(dir, 'credential-tools');
  mkdirSync(bin, { recursive: true });
  const cases = Object.entries(tools.items ?? {})
    .map(([item, value]) => `  ${quoted(item)}) printf '%s\\n' ${quoted(value)}; exit 0;;`)
    .join('\n');
  const security =
    tools.refuse === undefined
      ? `#!/bin/sh\ncase "$3" in\n${cases}\nesac\nexit 44\n`
      : `#!/bin/sh\nprintf '%s\\n' ${quoted(tools.refuse.stderr)} >&2\nexit ${tools.refuse.code}\n`;
  writeFileSync(join(bin, 'security'), security);
  chmodSync(join(bin, 'security'), 0o755);
  const gh =
    tools.ghToken !== undefined
      ? `#!/bin/sh\nprintf '%s\\n' ${quoted(tools.ghToken)}\n`
      : `#!/bin/sh\nexit ${tools.noGh ? 127 : 1}\n`;
  writeFileSync(join(bin, 'gh'), gh);
  chmodSync(join(bin, 'gh'), 0o755);
  return `${bin}:${path}`;
}
