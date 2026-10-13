// A copy of the fixture repository's `.sail/` for one test to edit. Bun caches modules by path, so a test that edits a
// definition and imports it needs a copy of its own.
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const FIXTURE_SAIL = join(import.meta.dir, '..', 'fixtures', 'repo', '.sail');

/** Copies the fixture's `.sail/` into `repoDir`, and returns the copy. */
export function copyFixture(repoDir: string): string {
  const sail = join(repoDir, '.sail');
  cpSync(FIXTURE_SAIL, sail, { recursive: true });
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
