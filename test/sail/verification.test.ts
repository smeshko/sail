// sail's own factory verification stage, run as a script: it writes the evidence of the tasks that changed no file
// into the pull request's body, under `## Verification`, before the closing `Closes` line.
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnSail } from '../helpers/own-sail';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const INTRO = 'What implement reported for each task that changed no file:';

/** Runs 06-verification/run.sh on `body` and `tasks`: its exit code, the body it wrote and its last stdout line. */
function runVerification(
  repo: TempRepo,
  body: string,
  tasks: { id: string; evidence: string }[],
): { code: number; body: string; last: string } {
  writeOwnSail(repo);
  const out = join(repo.home, `stage-out-${Date.now()}`);
  mkdirSync(out);
  const real = realpathSync(out);
  const bodyFile = join(real, 'body.in');
  const tasksFile = join(real, 'tasks.in');
  writeFileSync(bodyFile, body);
  writeFileSync(tasksFile, JSON.stringify(tasks));
  const child = Bun.spawnSync(
    [join(repo.dir, '.sail', 'workflows', 'factory', 'stages', '06-verification', 'run.sh')],
    {
      cwd: repo.dir,
      env: { ...repo.env, SAIL_BUN: process.execPath, INPUT_BODY: bodyFile, INPUT_TASKS: tasksFile, STAGE_OUT: real },
    },
  );
  const lines = child.stdout.toString().trim().split('\n');
  return {
    code: child.exitCode ?? -1,
    body: readFileSync(join(real, 'pr-body.md'), 'utf8'),
    last: lines.at(-1) ?? '',
  };
}

test('a body ending Closes FAKE-1 gets the section before that line, with each task id and evidence in order', async () => {
  await withTempRepo(async (repo) => {
    const result = runVerification(repo, '## Summary\n\nDone.\n\nCloses FAKE-1\n', [
      { id: 'TASK-002', evidence: 'bun run types: types/ is unchanged' },
      { id: 'TASK-004', evidence: '  second check passed\n' },
    ]);
    expect(result.code).toBe(0);
    expect(result.body).toBe(
      [
        '## Summary',
        '',
        'Done.',
        '',
        '## Verification',
        '',
        INTRO,
        '',
        '**TASK-002**',
        '',
        '```text',
        'bun run types: types/ is unchanged',
        '```',
        '',
        '**TASK-004**',
        '',
        '```text',
        'second check passed',
        '```',
        '',
        'Closes FAKE-1',
        '',
      ].join('\n'),
    );
    expect(JSON.parse(result.last)).toEqual({ tasks: ['TASK-002', 'TASK-004'] });
  });
}, 60_000);

test('a body with no Closes line gets the section appended', async () => {
  await withTempRepo(async (repo) => {
    const result = runVerification(repo, '## Summary\n\nDone.\n', [{ id: 'TASK-002', evidence: 'ok' }]);
    expect(result.body).toBe(
      [
        '## Summary',
        '',
        'Done.',
        '',
        '## Verification',
        '',
        INTRO,
        '',
        '**TASK-002**',
        '',
        '```text',
        'ok',
        '```',
        '',
      ].join('\n'),
    );
  });
}, 60_000);

test('evidence holding a run of three backticks is fenced with four', async () => {
  await withTempRepo(async (repo) => {
    const result = runVerification(repo, 'Body\n\nCloses FAKE-1\n', [{ id: 'TASK-002', evidence: 'a ``` b' }]);
    expect(result.body).toContain('\n````text\na ``` b\n````\n');
  });
}, 60_000);

test('evidence of 4100 characters is cut to 4000 and ends with the cut marker', async () => {
  await withTempRepo(async (repo) => {
    const result = runVerification(repo, 'Body\n\nCloses FAKE-1\n', [{ id: 'TASK-002', evidence: 'x'.repeat(4100) }]);
    expect(result.body).toContain(`\n\`\`\`text\n${'x'.repeat(4000)}… (cut)\n\`\`\`\n`);
    expect(result.body).not.toContain('x'.repeat(4001));
  });
}, 60_000);
