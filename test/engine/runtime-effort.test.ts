// A fake run of a workflow whose agent steps set an effort (ADW-498): it completes on the fakes, run.json records the effort
// and the start events carry it.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../../src/cli/exit-codes';
import { validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import { copyFixture, edit } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { withTempRepo } from '../helpers/temp-repo';

test('a fake run of a stage with effort medium and a step with effort high completes, and their start events and run.json carry the effort', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    edit(sail, 'workflows/ticket-to-pr/stages/spec/stage.ts', "model: 'deep',", "model: 'deep', effort: 'medium',");
    edit(sail, 'workflows/ticket-to-pr/stages/publish/stage.ts', 'permissions:', "effort: 'high',\n  permissions:");
    const run = await runCaptured(['FAKE-1'], repo.dir);
    expect([run.code, run.stderr]).toEqual([EXIT_OK, '']);
    const runs = join(repo.dir, '.sail-runs');
    const [id = ''] = readdirSync(runs).filter((name) => name !== 'fake');
    const dir = join(runs, id);
    expect(validateRunDir(dir).issues).toEqual([]);
    const events = readEvents(dir);
    const starts = events.filter((event) => event.type === 'stage:start' || event.type === 'step:start');
    expect(
      starts.map((event) => [event.key, 'effort' in event ? event.effort : undefined]).filter(([, effort]) => effort),
    ).toEqual([
      ['spec#1', 'medium'],
      ['publish#1/describe', 'high'],
    ]);
    const header = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(header.stages.spec.effort).toBe('medium');
    expect(header.stages.publish.steps[0].effort).toBe('high');
    expect(header.stages.implement).not.toHaveProperty('effort');
    expect(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).status).toBe('completed');
  });
}, 90_000);
