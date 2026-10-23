// A copy of the fixture repository's `.sail/` for one test to edit. Bun caches modules by path, so a test that edits a
// definition and imports it needs a copy of its own.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const OPEN_SCRIPT = 'workflows/ticket-to-pr/stages/open/run.sh';
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

const PUBLISH = 'workflows/ticket-to-pr/stages/publish';

/** `publish`: one stage of two steps, an agent that describes the change and a script that reports a pull request. */
const PUBLISH_FILES: Record<string, string> = {
  'stage.ts': `// publish: describes the change, then opens the pull request. Its outcome is the open step's.
import { agent, file, fromStep, script, stage, value, z } from 'sail';
import { TicketInput } from 'sail/intakes';

export const PrDescription = z.object({ title: z.string().max(120), bodyFile: z.string() });

export const PrInfo = z.object({ number: z.number().int(), url: z.string(), draft: z.boolean() });

export const publish = stage('publish', {
  consumes: { ticket: value(TicketInput), spec: file('spec.md') },
  output: PrInfo,
  steps: [
    agent('describe', {
      prompt: './describe.md',
      produces: { 'pr-body.md': 'file' },
      output: PrDescription,
      model: 'default',
      permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git log *', 'git diff *'] },
      budget: { maxTurns: 20, maxUsd: 1, maxMinutes: 5 },
    }),
    script('open', {
      run: './open.sh',
      consumes: { description: fromStep('describe').output() },
      output: PrInfo,
    }),
  ],
});
`,
  'describe.md': `Describe the change on this branch for its pull request, from the ticket and the spec.

Write \`pr-body.md\` with three sections: Summary, Changes and Testing.

Submit the pull request's title, ending with the ticket key in parentheses, and \`pr-body.md\` as the body file.
`,
  'open.sh': `#!/usr/bin/env bash
# The open step, as a stub: it reports the pull request it would open. Opening one goes through the CodeHost later.
set -euo pipefail

echo '{"number":1,"url":"fake://codehost/fixture/pull/1","draft":false}'
`,
};

const DESCRIBE_THEN_OPEN = `    const d = await run.stage(describe, { ticket: run.input, spec: s.files['spec.md'] });
    if (d.outcome === 'blocked') return run.fail(\`describe blocked: \${d.reason}\`);
    const pr = await run.stage(open, {
      title: d.output.title,
      body: d.files['pr-body.md'],
      ticketKey: run.input.ticketKey,
    });
    return { pr: pr.output };
`;

/**
 * Gives a copy of the fixture's `.sail/` a multi-step stage: `ticket-to-pr`'s `describe` and `open` become the two
 * steps of one private stage, `publish`, which the workflow calls last. The engine can't run a multi-step stage yet,
 * so the fixture has none: a test of how one is loaded, listed, frozen in a roster or refused writes it here.
 */
export function writePublish(sail: string): void {
  for (const [name, text] of Object.entries(PUBLISH_FILES)) {
    const file = write(sail, `${PUBLISH}/${name}`, text);
    if (name.endsWith('.sh')) chmodSync(file, 0o755);
  }
  for (const stage of ['describe', 'open']) {
    rmSync(join(sail, 'workflows', 'ticket-to-pr', 'stages', stage), { recursive: true });
  }
  const workflow = 'workflows/ticket-to-pr/workflow.ts';
  edit(sail, workflow, "import { describe } from './stages/describe/stage';\n", '');
  edit(
    sail,
    workflow,
    "import { open } from './stages/open/stage';\n",
    "import { publish } from './stages/publish/stage';\n",
  );
  edit(
    sail,
    workflow,
    DESCRIBE_THEN_OPEN,
    "    return run.stage(publish, { ticket: run.input, spec: s.files['spec.md'] });\n",
  );
}
