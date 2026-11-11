// A person's start of a run, end to end: the dashboard server checks and starts the real `sail` in a repository of the
// fixture's workflows, and answers what the CLI printed. For each source the check's text is the CLI's `--dry-run`
// output, and a refusal is the CLI's own line, so the rules of a start are the CLI's by construction. A started run is
// detached: it goes on after the dashboard stops.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_REFUSED } from '../../src/cli/exit-codes';
import { startDashboard } from '../../src/dashboard/server';
import { isRunIdOf } from '../../src/engine/run-id';
import { machineDir, readRegistry, registryDir } from '../../src/watch/registry';
import { copyFixture } from '../helpers/fixture';
import { sail, until } from '../helpers/sail-process';
import { withTempRepo } from '../helpers/temp-repo';

const POST = { 'X-Sail-Dashboard': '1', 'Content-Type': 'application/json' };

const statusOf = (dir: string) => readFileSync(join(dir, 'STATUS'), 'utf8').trim();

test('the dashboard checks and starts a ticket or a pull request as the CLI does, in the CLI’s own words', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    // A machine directory of its own, so the clone registers there and nowhere else.
    const env = { ...repo.env, SAIL_HOME: join(repo.home, '.sail') };
    // A refused start registers the clone, and leaves no run.
    expect((await sail(repo.dir, env, ['FAKE-2'])).code).toBe(EXIT_REFUSED);
    const registry = registryDir(machineDir(env));
    const { name = '' } = readRegistry(registry).entries.find((entry) => entry.clone === repo.dir) ?? {};
    const runs = join(repo.dir, '.sail-runs');
    const runIds = (prefix: string) =>
      (existsSync(runs) ? readdirSync(runs) : []).filter((id) => id.startsWith(prefix));

    const started = startDashboard({ registryDir: registry, port: 0, env });
    if ('refused' in started) throw new Error(started.refused);
    try {
      const base = `http://127.0.0.1:${started.port}/api/repos/${name}/starts`;
      const post = async (path: string, body: unknown) => {
        const response = await fetch(`${base}${path}`, { method: 'POST', headers: POST, body: JSON.stringify(body) });
        return { status: response.status, json: (await response.json()) as Record<string, unknown> };
      };

      // The check is the CLI's dry run: its text with 200 when the CLI exits 0, its refusal with 409 otherwise.
      const table: [string, string][] = [
        ['FAKE-1', 'ticket-to-pr'],
        ['FAKE-2', 'ticket-to-pr'],
        ['FAKE-3', 'ticket-to-pr'],
        ['NOPE-1', 'ticket-to-pr'],
        ['#1', 'review'],
      ];
      const seen: [string, number, number][] = [];
      for (const [source, workflow] of table) {
        const cli = await sail(repo.dir, env, [source, '--workflow', workflow, '--dry-run']);
        const checked = await post('/check', { source, workflow });
        if (cli.code === 0) {
          expect(checked.json.roster).toBe(cli.stdout.trim());
        } else {
          expect(checked.json.error).toBe(cli.stderr.trim());
        }
        seen.push([source, cli.code, checked.status]);
      }
      expect(seen.map(([source, , status]) => [source, status])).toEqual([
        ['FAKE-1', 200],
        ['FAKE-2', 409],
        ['FAKE-3', 409],
        ['NOPE-1', 409],
        ['#1', 409],
      ]);
      expect(seen.map(([source, code]) => [source, code])).toEqual([
        ['FAKE-1', 0],
        ['FAKE-2', 3],
        ['FAKE-3', 3],
        ['NOPE-1', 3],
        ['#1', 3],
      ]);
      expect(runIds('')).toEqual(['dashboard']);

      // A start of an undesignated ticket is refused in the CLI's words, offers --force, and leaves no run directory.
      const cliRefusal = await sail(repo.dir, env, ['FAKE-3', '--workflow', 'ticket-to-pr']);
      expect(cliRefusal.code).toBe(EXIT_REFUSED);
      const refused = await post('', { source: 'FAKE-3', workflow: 'ticket-to-pr', key: 'FAKE-3' });
      expect([refused.status, refused.json.error, refused.json.override]).toEqual([
        409,
        cliRefusal.stderr.trim(),
        'force',
      ]);
      expect(runIds('FAKE-3-')).toEqual([]);

      // A pull request is refused as the CLI refuses it: the fixture's `review` takes tickets.
      const cliPr = await sail(repo.dir, env, ['#1', '--workflow', 'review']);
      const refusedPr = await post('', { source: '#1', workflow: 'review', key: 'pr-1' });
      expect([refusedPr.status, refusedPr.json.error, refusedPr.json.override]).toEqual([
        409,
        cliPr.stderr.trim(),
        undefined,
      ]);
      expect(runIds('pr-')).toEqual([]);

      // A key that is not the ticket's is the engine's refusal.
      const wrong = await post('', { source: 'FAKE-1', workflow: 'ticket-to-pr', key: 'FAKE-9' });
      expect([wrong.status, String(wrong.json.error)]).toEqual([
        409,
        expect.stringContaining('--run-id takes the id of a new run of FAKE-1'),
      ]);
      expect(runIds('FAKE-')).toEqual([]);

      // With force it runs, and its header lists the check it overrode.
      const forced = await post('', {
        source: 'FAKE-3',
        workflow: 'ticket-to-pr',
        until: 'spec',
        force: true,
        key: 'FAKE-3',
      });
      const forcedId = String(forced.json.runId);
      expect([forced.status, isRunIdOf('FAKE-3', forcedId)]).toEqual([202, true]);
      const header = JSON.parse(readFileSync(join(runs, forcedId, 'run.json'), 'utf8'));
      expect([header.source.forced, header.source.via]).toEqual([['designation'], 'cli']);

      // A designated ticket: 202 with its run, `via: cli`, its log named by the run id, and a run that outlives the dashboard.
      const plain = await post('', { source: 'FAKE-1', workflow: 'ticket-to-pr', until: 'spec', key: 'FAKE-1' });
      const runId = String(plain.json.runId);
      expect([plain.status, isRunIdOf('FAKE-1', runId)]).toEqual([202, true]);
      expect(JSON.parse(readFileSync(join(runs, runId, 'run.json'), 'utf8')).source.via).toBe('cli');
      expect(existsSync(join(runs, 'dashboard', `${runId}.log`))).toBe(true);
      await started.stop();
      const waited = await until('the run to be suspended', () => statusOf(join(runs, runId)).startsWith('suspended'));
      expect(waited).toBe('the run to be suspended');
      expect(statusOf(join(runs, runId))).toStartWith('suspended until');
    } finally {
      await started.stop();
    }
  });
}, 240_000);
