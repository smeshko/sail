// A copy of the fixture repository's `.sail/` for one test to edit. Bun caches modules by path, so a test that edits a
// definition and imports it needs a copy of its own.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const FIXTURE_SAIL = join(import.meta.dir, '..', 'fixtures', 'repo', '.sail');

/** Copies the fixture's `.sail/` into `repoDir`, and returns the copy. */
export function copyFixture(repoDir: string): string {
  const sail = join(repoDir, '.sail');
  cpSync(FIXTURE_SAIL, sail, { recursive: true });
  return sail;
}

/**
 * Where `land` lives: the review operations demonstration (ADW-127), kept beside the fixture repository rather than in
 * it, so the fixture's roster and its golden run stay ticket-to-pr's alone.
 */
export const LAND_SAIL = join(import.meta.dir, '..', 'fixtures', 'land', '.sail');

/** Adds `land` to the copy `sail` of the fixture's `.sail/`, as `workflows/land/`, and returns `sail`. */
export function addLand(sail: string): string {
  cpSync(LAND_SAIL, sail, { recursive: true });
  return sail;
}

/** Writes `text` to `path` under `sail`, making its folder, and returns the file. */
export function write(sail: string, path: string, text: string): string {
  const file = join(sail, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** Replaces `from` with `to` in the file at `path` under `sail`, which must hold it, and returns the file. */
export function edit(sail: string, path: string, from: string, to: string): string {
  const file = join(sail, path);
  const text = readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`${path} has no ${from}`);
  writeFileSync(file, text.replace(from, to));
  return file;
}

const OPEN_SCRIPT = 'workflows/ticket-to-pr/stages/publish/open.sh';
const OPENED = '--body-file "$INPUT_BODY" --ticket "$ticket" --label sail)\n';

/**
 * Makes a copy's `open` step hold once `open-pull-request` has answered, in a run whose environment sets
 * `HOLD_AFTER_OPEN` to a file: the script writes its pid there, which leads its process group, and sleeps a minute. A
 * test waits for the file, kills the run and that group there, and resumes it. Without the variable it runs as it was.
 */
export function holdAfterOpen(sail: string): string {
  const file = join(sail, OPEN_SCRIPT);
  const text = readFileSync(file, 'utf8');
  if (text.split(OPENED).length !== 2) throw new Error(`${OPEN_SCRIPT} has no single open-pull-request answer`);
  // Spliced in with a function, not through edit(): a replacement string would read the shell's `$$` as one `$`.
  const hold = `if [ -n "\${HOLD_AFTER_OPEN:-}" ]; then echo "$$" >"$HOLD_AFTER_OPEN"; exec sleep 60; fi\n`;
  writeFileSync(
    file,
    text.replace(OPENED, () => `${OPENED}${hold}`),
  );
  return file;
}

const PUBLISH_OPEN = 'workflows/ticket-to-pr/stages/publish/open.sh';
const STRICT = 'set -euo pipefail\n';

/**
 * Makes a copy's `publish` stage hold as its `open` step starts, before it pushes, in a run whose environment sets
 * `HOLD_BEFORE_OPEN` to a file: the script writes its pid there, which leads its process group, and sleeps a minute.
 * `describe` is journaled by then, so a test that waits for the file and kills the run there resumes it between the
 * two steps. Without the variable the step runs as it was.
 */
export function holdBeforeOpen(sail: string): string {
  const file = join(sail, PUBLISH_OPEN);
  const text = readFileSync(file, 'utf8');
  if (text.split(STRICT).length !== 2) throw new Error(`${PUBLISH_OPEN} has no single ${STRICT.trim()}`);
  // Spliced in with a function, not through edit(): a replacement string would read the shell's `$$` as one `$`.
  const hold = `if [ -n "\${HOLD_BEFORE_OPEN:-}" ]; then echo "$$" >"$HOLD_BEFORE_OPEN"; exec sleep 60; fi\n`;
  writeFileSync(
    file,
    text.replace(STRICT, () => `${STRICT}${hold}`),
  );
  return file;
}

/**
 * Waits for the pid `holdAfterOpen()`'s step writes to `file`, then SIGKILLs `child`, the run, and that step's process
 * group, and waits for `child` to end. Answers whether the step was held: false when `child` ended first, or nothing
 * held within `timeoutMs`, and then nothing is killed but `child`.
 */
export async function killWhenHeld(file: string, child: Bun.Subprocess, timeoutMs = 30_000): Promise<boolean> {
  let ended = false;
  void child.exited.then(() => {
    ended = true;
  });
  const deadline = performance.now() + timeoutMs;
  const pid = () => (existsSync(file) ? Number(readFileSync(file, 'utf8').trim()) || undefined : undefined);
  while (pid() === undefined && !ended && performance.now() < deadline) await Bun.sleep(20);
  const held = pid();
  child.kill('SIGKILL');
  await child.exited;
  if (held === undefined) return false;
  try {
    process.kill(-held, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  return true;
}

export interface OwnIntakeOptions {
  /** The exit code `fetch.sh` ends with: 0 unless a test makes the script step fail. */
  fetchExit?: number;
  /** The name of the intake's agent step, which `.sail/fake/harness.json` answers as `intake/<name>`. */
  agentStep?: string;
  /** The workflow's name: `groom`. */
  workflow?: string;
}

const ownIntakeFiles = (workflow: string, agentStep: string, fetchExit: number): Record<string, string> => ({
  [`workflows/${workflow}/intake.ts`]: `// groom: an intake of the repository's own. fetch writes the brief, shape titles it.
import { agent, fromStep, intake, script, value, z } from 'sail';

const Groomed = z.object({ title: z.string() });

const fetch = script('fetch', {
  run: './fetch.sh',
  consumes: { source: value(z.object({ kind: z.string(), ticketKey: z.string() }).passthrough()) },
  produces: { 'fetched.md': 'file' },
  output: z.object({ ticketKey: z.string() }),
  exitCodes: { passed: [0], failed: [1] },
});

const shape = agent('${agentStep}', {
  prompt: './shape.md',
  consumes: { fetched: fromStep('fetch').file('fetched.md') },
  output: Groomed,
  model: 'default',
  permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
  budget: { maxTurns: 4, maxUsd: 1, maxMinutes: 5 },
});

export const groom = intake('groom', {
  accepts: ['ticket'],
  output: Groomed,
  produces: { 'brief.md': 'file' },
  steps: [fetch, shape],
});
`,
  [`workflows/${workflow}/fetch.sh`]: `#!/usr/bin/env bash
# fetch: writes the brief of the ticket the run came from, and names it.
set -euo pipefail
STUB="$(dirname "$(dirname "$SAIL_CONFIG")")/.stub"
mkdir -p "$STUB"
echo "$STAGE#$CALL/fetch" >>"$STUB/executions.log"
key=$("\${SAIL_BUN:-bun}" -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).ticketKey)' "$INPUT_SOURCE")
echo "# Brief for $key" >"$STAGE_OUT/brief.md"
cp "$STAGE_OUT/brief.md" "$STAGE_OUT/fetched.md"
printf '{"ticketKey": "%s"}\\n' "$key"
if [ "${fetchExit}" != 0 ]; then echo "no brief for $key" >&2; fi
exit ${fetchExit}
`,
  [`workflows/${workflow}/shape.md`]: 'Give the brief the fetch step wrote a title.\n',
  [`workflows/${workflow}/workflow.ts`]: `// ${workflow}: a ticket groomed by its own intake, then echoed.
import { workflow } from 'sail';
import { echo } from '../../stages/echo/stage';
import { groom } from './intake';

export default workflow('${workflow}', { intake: groom, version: 1 }, async (run) => {
  const brief = run.intake.files['brief.md'];
  const first = await run.stage(echo, { title: run.input.title, brief });
  if (first.outcome !== 'passed') return run.fail(\`echo \${first.outcome}\`);
  const again = await run.stage(echo, { title: first.output.title, brief });
  if (again.outcome !== 'passed') return run.fail(\`echo \${again.outcome}\`);
  return { title: run.input.title, brief: again.output.brief };
});
`,
  'stages/echo/stage.ts': `// echo: prints the title it was given, and the first line of the brief.
import { file, script, value, z } from 'sail';

export const echo = script('echo', {
  run: './run.sh',
  consumes: { title: value(z.string()), brief: file('brief.md') },
  output: z.object({ title: z.string(), brief: z.string() }),
});
`,
  'stages/echo/run.sh': `#!/usr/bin/env bash
set -euo pipefail
printf '{"title": "%s", "brief": "%s"}\\n' "$(cat "$INPUT_TITLE")" "$(head -n 1 "$INPUT_BRIEF")"
`,
});

/** Writes the workflow `groom`, its own intake and the shared stage `echo` to the copy `sail` of the fixture's `.sail/`. */
export function writeOwnIntake(sail: string, options: OwnIntakeOptions = {}): void {
  const { fetchExit = 0, agentStep = 'shape', workflow = 'groom' } = options;
  for (const [path, text] of Object.entries(ownIntakeFiles(workflow, agentStep, fetchExit))) {
    const file = write(sail, path, text);
    if (path.endsWith('.sh')) chmodSync(file, 0o755);
  }
}

/** Sets `.sail/fake/harness.json`'s answers for `key`, such as `intake/shape`, to `answers`. */
export function seedHarness(sail: string, key: string, answers: unknown[]): void {
  const path = join(sail, 'fake', 'harness.json');
  const seeds = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  seeds[key] = answers;
  writeFileSync(path, `${JSON.stringify(seeds, null, 2)}\n`);
}
