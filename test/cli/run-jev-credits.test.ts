// A run whose script step asks Jev while the TypeSafe account has no credits (a seeded 402): the step carries on, the
// run completes, and the failure is said in the terminal view, in `events.ndjson` and in `summary.json`.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../../src/cli/exit-codes';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import { copyFixture, edit, write } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { withTempRepo } from '../helpers/temp-repo';
import { THREE_QUESTIONS } from '../ports/jev.suite';

const CREDITS = 'jev.ask: the TypeSafe account has no credits: TypeSafe answered 402 Payment Required: billing_error';

const WORKFLOW = `import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { askJev } from './stages/ask-jev/stage';

export default workflow('ask', { intake: ticket, version: 1 }, async (run) => {
  await run.stage(askJev, {});
  return { asked: true };
});
`;

const STAGE = `import { script, z } from 'sail';

export const askJev = script('ask-jev', {
  run: './run.sh',
  ports: ['jev'],
  output: z.object({}),
});
`;

test('a step whose Jev ask hit a 402 completes the run, with the error in the terminal view, the events and the summary', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    edit(sail, 'project.yaml', '  workspace: { use: fake }\n', '  workspace: { use: fake }\n  jev: { use: fake }\n');
    write(sail, 'fake/jev.json', JSON.stringify({ error: { status: 402, detail: 'billing_error' } }));
    write(sail, 'workflows/ask/workflow.ts', WORKFLOW);
    write(sail, 'workflows/ask/stages/ask-jev/stage.ts', STAGE);
    write(sail, 'workflows/ask/stages/ask-jev/body.json', JSON.stringify(THREE_QUESTIONS));
    const script = write(
      sail,
      'workflows/ask/stages/ask-jev/run.sh',
      '#!/usr/bin/env bash\nsail port jev ask --body-file "$(dirname "$0")/body.json" || true\necho {}\n',
    );
    Bun.spawnSync(['chmod', '+x', script]);

    const { code, stdout } = await runCaptured(['FAKE-1', '--workflow', 'ask', '-q'], repo.dir);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain(`ask-jev#1`);
    expect(stdout).toContain(`✗ error:port: ${CREDITS}`);

    const [id = ''] = readdirSync(join(repo.dir, '.sail-runs')).filter((name) => name !== 'fake');
    const dir = join(repo.dir, '.sail-runs', id);
    const events = readFileSync(join(dir, 'events.ndjson'), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === 'error:port')).toEqual([
      expect.objectContaining({ key: 'ask-jev#1', port: 'jev', op: 'ask', code: 'payment_required', message: CREDITS }),
    ]);
    expect(events.some((event) => event.type === 'run:suspended')).toBe(false);
    expect(events.find((event) => event.type === 'run:end')).toMatchObject({ status: 'completed' });

    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    expect(validateDocument('sail.summary.v1', summary).map(formatIssue)).toEqual([]);
    expect(summary.calls.find((call: { key: string }) => call.key === 'ask-jev#1').portErrors).toEqual([
      { port: 'jev', op: 'ask', code: 'payment_required', message: CREDITS },
    ]);
  });
}, 30_000);
