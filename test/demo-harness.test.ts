// sail's own demo harness, `.sail/lib/demo.mjs`: `new --own` makes a demo repository from the repository's own
// `.sail/` with every adapter on fake, while `--from` still refuses a `.sail/` whose ports aren't.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempRepo } from './helpers/temp-repo';

const ROOT = join(import.meta.dir, '..');
const DEMO = join(ROOT, '.sail', 'lib', 'demo.mjs');

async function demo(env: Record<string, string>, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, DEMO, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("new --own holds the repository's own .sail/ with every adapter, named harnesses too, on fake", async () => {
  await withTempRepo(async (repo) => {
    const dir = join(repo.dir, 'demo');
    const { code } = await demo(repo.env, 'new', dir, '--own');
    const project = Bun.YAML.parse(readFileSync(join(dir, 'repo', '.sail', 'project.yaml'), 'utf8')) as {
      adapters: Record<string, unknown>;
    };
    const own = Bun.YAML.parse(readFileSync(join(ROOT, '.sail', 'project.yaml'), 'utf8')) as {
      adapters: { harnesses?: Record<string, unknown> } & Record<string, unknown>;
    };
    const jev = JSON.parse(readFileSync(join(dir, 'repo', '.sail', 'fake', 'jev.json'), 'utf8'));
    // The fake factory's task and its fix pass's findings answer below a clear yes, so the check agents still run.
    const checks = ['TASK-001', 'V1', 'D1', 'R2'].map((id) => jev.answers?.[id]?.noul);
    expect(checks.every((noul: number | undefined) => noul !== undefined && noul < 0.95)).toBe(true);
    const { harnesses, ...ports } = own.adapters;
    expect({
      code,
      adapters: project.adapters,
      workflows: existsSync(join(dir, 'repo', '.sail', 'workflows', 'groom', 'workflow.ts')),
      conventions: existsSync(join(dir, 'repo', 'AGENTS.md')) && existsSync(join(dir, 'repo', 'CONTEXT.md')),
    }).toEqual({
      code: 0,
      adapters: {
        ...Object.fromEntries(Object.keys(ports).map((port) => [port, { use: 'fake' }])),
        ...(harnesses === undefined
          ? {}
          : { harnesses: Object.fromEntries(Object.keys(harnesses).map((name) => [name, { use: 'fake' }])) }),
      },
      workflows: true,
      conventions: true,
    });
  });
});

test("new --from the repository's own .sail/ is still refused: its ports aren't fake", async () => {
  await withTempRepo(async (repo) => {
    const { code, stderr } = await demo(repo.env, 'new', join(repo.dir, 'demo'), '--from', join(ROOT, '.sail'));
    expect({ code, refused: stderr.includes('every port must be on fake') }).toEqual({ code: 2, refused: true });
  });
});

test('new --runs copies a run directory under its runId and a .sail-runs folder as it is', async () => {
  await withTempRepo(async (repo) => {
    const dir = join(repo.dir, 'demo');
    const { code, stdout } = await demo(
      repo.env,
      'new',
      dir,
      '--runs',
      join(ROOT, 'test', 'fixtures', 'playback', 'fake-1-claude-code'),
      '--runs',
      join(ROOT, 'test', 'fixtures', 'dashboard', 'beta'),
    );
    const runs = join(dir, 'repo', '.sail-runs');
    const tracked = Bun.spawnSync(['git', 'ls-files', '.sail-runs'], { cwd: join(dir, 'repo'), env: repo.env });
    const files = new TextDecoder().decode(tracked.stdout);
    expect({
      code,
      seeded: stdout.includes('seeded .sail-runs/ from'),
      recorded: existsSync(join(runs, 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N', 'run.json')),
      beta: existsSync(join(runs, 'FAKE-3-01M39H4ZW0S46MV303CFX3T4PY', 'run.json')),
      queue: existsSync(join(runs, 'queue', 'ticket-to-pr', 'queue.json')),
      committed: files.includes('.sail-runs/queue/ticket-to-pr/queue.json'),
    }).toEqual({ code: 0, seeded: true, recorded: true, beta: true, queue: true, committed: true });
  });
});

test("new --runs refuses a folder that doesn't exist", async () => {
  await withTempRepo(async (repo) => {
    const dir = join(repo.dir, 'demo');
    const { code, stderr } = await demo(repo.env, 'new', dir, '--runs', join(repo.dir, 'missing'));
    expect({ code, named: stderr.includes('missing'), made: existsSync(join(dir, 'repo')) }).toEqual({
      code: 2,
      named: true,
      made: false,
    });
  });
});
