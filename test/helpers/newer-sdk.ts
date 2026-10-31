// A repository whose committed `.sail/` uses an option of `workflow()` that only its own `types/` declares: what a
// merge that changes the SDK and its first use in `.sail/` together leaves at the default branch, for a sail older than
// that merge.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { edit } from './fixture';
import type { TempRepo } from './temp-repo';

const SAIL_TYPES = join(import.meta.dir, '..', '..', 'types');
const OPTION = 'readonly version?: number;';

/** How the commit's `types/` and `package.json` stand. */
export interface NewerSdk {
  /** `own`: a copy of sail's `types/` declaring `demoOption`; `none`: no `types/`; `plain`: sail's own, without it. */
  types?: 'own' | 'none' | 'plain';
  /** The `package.json` name. Defaults to sail's own. */
  name?: string;
  /** The value `workflow()` is passed as `demoOption`, as source. Defaults to `'x'`. */
  use?: string;
}

/** Writes `types/` and `package.json` into the repository, and has `workflow` (a path under `sail`) pass `demoOption`. */
export function useNewerSdk(repo: TempRepo, sail: string, workflow: string, options: NewerSdk = {}): void {
  const { types = 'own', name = '@smeshko/sail', use = "'x'" } = options;
  writeFileSync(join(repo.dir, 'package.json'), `${JSON.stringify({ name })}\n`);
  if (types !== 'none') {
    cpSync(SAIL_TYPES, join(repo.dir, 'types'), { recursive: true });
    if (types === 'own') {
      const declarations = join(repo.dir, 'types', 'workflow.d.ts');
      const text = readFileSync(declarations, 'utf8');
      if (!text.includes(OPTION)) throw new Error('types/workflow.d.ts has no version option');
      writeFileSync(declarations, text.replace(OPTION, `${OPTION}\n    readonly demoOption?: string;`));
    }
  }
  edit(sail, workflow, 'version: 1', `version: 1, demoOption: ${use}`);
}
