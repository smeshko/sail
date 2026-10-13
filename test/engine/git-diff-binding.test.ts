// A `gitDiff('<base>...HEAD')` binding, resolved from the run's worktree (TASK-010): the engine writes the resolved patch as
// `<name>.patch` into `$STAGE_IN`, and a range it cannot resolve fails the run, naming the binding.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTINS } from '../../src/adapters/index';
import { bindingProblems, materialise, type Supplied } from '../../src/engine/bindings';
import { readJournal } from '../../src/engine/journal';
import { type RunEnd, runWorkflow } from '../../src/engine/runtime';
import { type Consumes, gitDiff } from '../../src/sdk/index';
import { fakeAdapters } from '../helpers/adapters';
import { edit, write } from '../helpers/fixture';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const RANGE = "gitDiff('origin/HEAD...HEAD')";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-gitdiff-')));
  dirs.push(dir);
  return dir;
}

/**
 * A stub repository whose origin is a repository of its own, with `origin/HEAD` set and workspace on git-worktree, and a
 * workflow of two stages: `edit-worktree` creates a file in the run's worktree, and `see-diff` consumes the run's diff.
 */
async function withDiffWorkflow(check: (repo: TempRepo) => Promise<void>): Promise<void> {
  // A precondition the feature needs (TASK-005): the built-ins name git-worktree, so a run can use it.
  expect(Object.keys(BUILTINS)).toContain('git-worktree');
  await withTempRepo(async (origin) => {
    await withTempRepo(async (repo) => {
      repo.git('remote', 'add', 'origin', origin.dir);
      repo.git('fetch', 'origin');
      repo.git('remote', 'set-head', 'origin', '-a');
      const sail = writeStub(repo.dir);
      edit(sail, 'project.yaml', 'workspace: { use: fake }', 'workspace: { use: git-worktree }');
      write(
        sail,
        'workflows/ticket-to-pr/stages/edit-worktree/stage.ts',
        `// edit-worktree: a file the run creates in its worktree, for the next stage's diff to show.
import { script, z } from 'sail';

export const editWorktree = script('edit-worktree', { run: './run.sh', output: z.object({}) });
`,
      );
      const edits = write(
        sail,
        'workflows/ticket-to-pr/stages/edit-worktree/run.sh',
        `#!/usr/bin/env bash
set -euo pipefail
echo 'an edit made in the run' >"$WORKSPACE/edit.txt"
echo '{}'
`,
      );
      chmodSync(edits, 0o755);
      write(
        sail,
        'workflows/ticket-to-pr/stages/see-diff/stage.ts',
        `// see-diff: counts the files of the run's diff that are the edit, one diff --git header each.
import { gitDiff, script, z } from 'sail';

export const seeDiff = script('see-diff', {
  run: './run.sh',
  consumes: { diff: gitDiff('origin/HEAD...HEAD') },
  output: z.object({ names: z.number().int() }),
});
`,
      );
      const seen = write(
        sail,
        'workflows/ticket-to-pr/stages/see-diff/run.sh',
        `#!/usr/bin/env bash
set -euo pipefail
names=$(grep -c '^diff --git .*edit.txt' "$INPUT_DIFF" || true)
echo "{\\"names\\":$names}"
`,
      );
      chmodSync(seen, 0o755);
      write(
        sail,
        'workflows/ticket-to-pr/workflow.ts',
        `// ticket-to-pr, for the git-diff binding: one stage edits the worktree, the next consumes the run's diff.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { editWorktree } from './stages/edit-worktree/stage';
import { seeDiff } from './stages/see-diff/stage';

export default workflow('ticket-to-pr', { intake: ticket, version: 1 }, async (run) => {
  await run.stage(editWorktree);
  return run.stage(seeDiff);
});
`,
      );
      await check(repo);
    });
  });
}

/** The run, from `repo` on `FAKE-1`, under the repository's own HOME, run to its end. */
async function runIn(repo: TempRepo): Promise<RunEnd> {
  const end = await runWorkflow({
    cwd: repo.dir,
    adapters: await fakeAdapters(repo.dir, repo.env),
    workflow: 'ticket-to-pr',
    ticket: 'FAKE-1',
  });
  if ('refused' in end) throw new Error(`refused: ${end.refused}`);
  return end;
}

// STICKER: the resolved gitDiff binding is TASK-010's. Each sticker names that task.

// biome-ignore format: TDD-PENDING TASK-010
test
  .skip // TDD-PENDING TASK-010
  ('a gitDiff binding the engine resolved is written as <name>.patch in $STAGE_IN, and INPUT_ names it', () => {
    const dir = tempDir();
    const stageIn = join(dir, 'call-1', 'in');
    mkdirSync(stageIn, { recursive: true });
    const consumes: Consumes = { diff: gitDiff('origin/HEAD...HEAD') };
    const supplied: Record<string, Supplied> = {
      diff: { kind: 'gitDiff', patch: 'diff --git a/x b/x\n', from: RANGE },
    };
    expect(bindingProblems(consumes, supplied)).toEqual([]);
    const { inputs, consumed } = materialise(consumes, supplied, stageIn);
    expect({
      inputs,
      consumed,
      patch: readFileSync(join(stageIn, 'diff.patch'), 'utf8'),
    }).toEqual({
      inputs: { INPUT_DIFF: join(stageIn, 'diff.patch') },
      consumed: { diff: RANGE },
      patch: 'diff --git a/x b/x\n',
    });
  });

// biome-ignore format: TDD-PENDING TASK-010
test
  .skip // TDD-PENDING TASK-010
  ('a stage consuming gitDiff(origin/HEAD...HEAD) finds the edit the run made, in its $STAGE_IN, and the journal holds the range', async () => {
    await withDiffWorkflow(async (repo) => {
      const end = await runIn(repo);
      const seeDir = readdirSync(end.dir).find((name) => name.endsWith('-see-diff')) ?? '';
      const result = JSON.parse(readFileSync(join(end.dir, seeDir, 'call-1', 'result.json'), 'utf8'));
      const entry = readJournal(end.dir).entries.find((line) => line.key === 'see-diff#1');
      expect({
        status: end.status,
        names: (entry?.output as { names?: number } | undefined)?.names,
        consumed: result.consumed?.diff,
      }).toEqual({ status: 'completed', names: 1, consumed: RANGE });
    });
  });

// biome-ignore format: TDD-PENDING TASK-010
test
  .skip // TDD-PENDING TASK-010
  ('a gitDiff whose right side is not HEAD fails the run with workflow_failed, naming the binding', async () => {
    await withDiffWorkflow(async (repo) => {
      edit(
        join(repo.dir, '.sail'),
        'workflows/ticket-to-pr/stages/see-diff/stage.ts',
        "gitDiff('origin/HEAD...HEAD')",
        "gitDiff('origin/HEAD...main')",
      );
      const end = await runIn(repo);
      expect({
        status: end.status,
        stopReason: end.stopReason,
        namesBinding: (end.message ?? '').includes('diff'),
      }).toEqual({ status: 'failed', stopReason: 'workflow_failed', namesBinding: true });
    });
  });
