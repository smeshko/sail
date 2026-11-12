// groom's overlap comparison (.sail/lib/overlap.mjs): the paths a plan names, the paths two plans share, the plan
// attached last, and the order overlapping tickets are tried in. Then the overlap stage's script, run on a `sail` that
// answers `sail port ticket-source` from a file.
import { beforeAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Candidate {
  ticketKey: string;
  attachedAt: string;
  shared: string[];
}

interface Overlap {
  IGNORED: string[];
  planPaths(planText: string, parseTasks: (plan: string) => { paths: string[] }[]): string[];
  sharedPaths(mine: readonly string[], theirs: readonly string[]): string[];
  lastPlan(files: { name: string; text: string }[]): { name: string; text: string; attachedAt: string } | undefined;
  byRecency(candidates: Candidate[]): Candidate[];
  why(shared: readonly string[]): string;
}

const ROOT = join(import.meta.dir, '..', '..');
let lib: Overlap;
let jev: { parseTasks(plan: string): { id: string; paths: string[] }[] };
beforeAll(async () => {
  lib = (await import(join(ROOT, '.sail', 'lib', 'overlap.mjs'))) as Overlap;
  jev = await import(join(ROOT, '.sail', 'lib', 'jev-check.mjs'));
});

/** A plan of two tasks, each with the Files block given. */
function plan(first: string, second: string): string {
  return `# Plan: a thing

## Tasks

- [ ] TASK-001: First
- [ ] TASK-002: Second

## Task details

### TASK-001: First

Type: impl

Files:
- ${first}

Acceptance:
- [ ] it works, see \`src/never.ts\`

### TASK-002: Second

Type: impl

Files: ${second}

Acceptance:
- [ ] it works
`;
}

const attached = (attachedAt: unknown) =>
  `# Plan\n\n<!-- sail:plan ${JSON.stringify({ version: 1, attachedAt })} -->\n`;

test('planPaths names each path of the tasks once, without a leading ./, a :line or CONTEXT.md', () => {
  const text = plan('`src/a.ts` (new), `CONTEXT.md`, a term', '`./src/a.ts`, and `test/a.test.ts:12`');
  expect(lib.planPaths(text, jev.parseTasks)).toEqual(['src/a.ts', 'test/a.test.ts']);
  expect(lib.IGNORED).toEqual(['CONTEXT.md']);
});

test('planPaths of a plan with no task details is empty', () => {
  expect(lib.planPaths('# Plan: nothing\n', jev.parseTasks)).toEqual([]);
});

test('sharedPaths is empty for two plans that share only CONTEXT.md, and names a path both change', () => {
  const mine = lib.planPaths(plan('`CONTEXT.md`', '`src/a.ts`'), jev.parseTasks);
  const theirs = lib.planPaths(plan('`CONTEXT.md`', '`src/b.ts`'), jev.parseTasks);
  expect(lib.sharedPaths(mine, theirs)).toEqual([]);
  expect(
    lib.sharedPaths(
      ['src/x.ts', 'src/dashboard/page/app.ts', 'src/a.ts'],
      ['src/a.ts', 'src/dashboard/page/app.ts', 'src/y.ts'],
    ),
  ).toEqual(['src/dashboard/page/app.ts', 'src/a.ts']);
});

test('lastPlan picks the plan attached last, and passes over a file with no trailer, a trailer that is no JSON and one without attachedAt', () => {
  const files = [
    { name: 'notes.md', text: '# Notes\n' },
    { name: 'older', text: attached('2026-11-01T09:00:00.000Z') },
    { name: 'newer', text: `${attached('2026-11-02T09:00:00.000Z')}\n\n` },
    { name: 'broken', text: '# Plan\n\n<!-- sail:plan {not json} -->\n' },
    { name: 'undated', text: '# Plan\n\n<!-- sail:plan {"version":1} -->\n' },
    { name: 'numbered', text: attached(20261103) },
    { name: 'empty', text: '' },
  ];
  expect(lib.lastPlan(files)).toEqual({
    name: 'newer',
    text: `${attached('2026-11-02T09:00:00.000Z')}\n\n`,
    attachedAt: '2026-11-02T09:00:00.000Z',
  });
  expect(lib.lastPlan(files.reverse())?.name).toBe('newer');
});

test('lastPlan of files that hold no plan is undefined', () => {
  expect(lib.lastPlan([])).toBeUndefined();
  expect(lib.lastPlan([{ name: 'notes.md', text: '# Notes\n' }])).toBeUndefined();
});

test('byRecency drops a candidate with nothing shared and puts the plan attached last first, ties by ticket key', () => {
  const candidates = [
    { ticketKey: 'FAKE-1', attachedAt: '2026-11-01T09:00:00.000Z', shared: ['src/a.ts'] },
    { ticketKey: 'FAKE-9', attachedAt: '2026-11-09T09:00:00.000Z', shared: [] },
    { ticketKey: 'FAKE-4', attachedAt: '2026-11-03T09:00:00.000Z', shared: ['src/a.ts'] },
    { ticketKey: 'FAKE-3', attachedAt: '2026-11-03T09:00:00.000Z', shared: ['src/b.ts'] },
  ];
  expect(lib.byRecency(candidates).map((each) => each.ticketKey)).toEqual(['FAKE-3', 'FAKE-4', 'FAKE-1']);
});

test('why names up to three shared paths, then how many more', () => {
  expect(lib.why(['src/a.ts'])).toBe('its plan also changes `src/a.ts`');
  expect(lib.why(['src/a.ts', 'src/b.ts', 'src/c.ts'])).toBe(
    'its plan also changes `src/a.ts`, `src/b.ts`, `src/c.ts`',
  );
  expect(lib.why(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'])).toBe(
    'its plan also changes `src/a.ts`, `src/b.ts`, `src/c.ts` and 1 more',
  );
});

/** A ticket of the stub's world: its plans, each an attached file's text, and the tickets it waits on. */
interface StubTicket {
  state: 'unstarted' | 'started' | 'completed';
  labels: string[];
  files?: string[];
  prerequisites?: string[];
  /** The download is refused, as a provider that is down refuses it. */
  refuses?: boolean;
}

/** `sail port ticket-source list|download|get`, answered from $STUB_WORLD, each call's arguments logged to $STUB_CALLS. */
const STUB = String.raw`import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [, , operation, ...args] = process.argv.slice(2);
appendFileSync(process.env.STUB_CALLS, [operation, ...args].join(' ') + '\n');
const world = JSON.parse(readFileSync(process.env.STUB_WORLD, 'utf8'));
const option = (name) => args[args.indexOf(name) + 1];
if (operation === 'list') {
  const listed = Object.entries(world)
    .filter(([, ticket]) => ticket.state === option('--state') && ticket.labels.includes(option('--label')))
    .map(([ticketKey]) => ({ ticketKey }));
  console.log(JSON.stringify(listed));
} else if (operation === 'download') {
  const [ticketKey] = args;
  if (world[ticketKey].refuses) {
    console.error('the provider is down');
    process.exit(1);
  }
  const out = option('--out');
  mkdirSync(out, { recursive: true });
  const files = (world[ticketKey].files ?? []).map((text, index) => {
    const path = join(out, 'file-' + index + '.md');
    writeFileSync(path, text);
    return { name: 'file-' + index, url: 'stub://' + index, path };
  });
  files.push({ name: 'a link', url: 'https://example.com', skipped: 'never fetched' });
  console.log(JSON.stringify({ ticketKey, files }));
} else {
  const [ticketKey] = args;
  const prerequisites = (world[ticketKey]?.prerequisites ?? []).map((key) =>
    world[key] === undefined ? { ticketKey: key } : { ticketKey: key, state: { type: world[key].state } },
  );
  console.log(JSON.stringify({ ticketKey, prerequisites }));
}
`;

const STAGE = join(ROOT, '.sail', 'workflows', 'groom', 'stages', '07-overlap', 'run.sh');

/** A plan as groom attaches it: one task whose Files names `paths`, then its trailer. */
function planOf(paths: string[], attachedAt?: string): string {
  const files = paths.map((path) => `\`${path}\``).join(', ');
  const body = `# Plan: a thing\n\n## Tasks\n\n- [ ] TASK-001: First\n\n## Task details\n\n### TASK-001: First\n\nFiles: ${files}\n`;
  return attachedAt === undefined
    ? body
    : `${body}\n<!-- sail:plan ${JSON.stringify({ version: 1, attachedAt })} -->\n`;
}

/** Runs the overlap stage for FAKE-2, whose new plan names `paths`, in `world`: its exit, its Overlap and the calls it made. */
function runStage(paths: string[], world: Record<string, StubTicket>) {
  const dir = mkdtempSync(join(tmpdir(), 'overlap-stage-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'stub.mjs'), STUB);
  writeFileSync(join(bin, 'sail'), `#!/usr/bin/env bash\nexec "${process.execPath}" "${join(dir, 'stub.mjs')}" "$@"\n`);
  chmodSync(join(bin, 'sail'), 0o755);
  writeFileSync(join(dir, 'world.json'), JSON.stringify(world));
  writeFileSync(join(dir, 'ticketKey'), 'FAKE-2\n');
  writeFileSync(join(dir, 'plan.md'), planOf(paths));
  mkdirSync(join(dir, 'scratch'));
  const calls = join(dir, 'calls');
  const result = Bun.spawnSync([STAGE], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      SAIL_BUN: process.execPath,
      SAIL_CONFIG: join(ROOT, '.sail', 'project.yaml'),
      INPUT_TICKETKEY: join(dir, 'ticketKey'),
      INPUT_PLAN: join(dir, 'plan.md'),
      TMPDIR: join(dir, 'scratch'),
      STUB_WORLD: join(dir, 'world.json'),
      STUB_CALLS: calls,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = result.stdout.toString().trim();
  return {
    code: result.exitCode,
    stderr: result.stderr.toString(),
    output: stdout === '' ? undefined : JSON.parse(stdout.split('\n').at(-1) ?? ''),
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
  };
}

const SHOW = 'src/cli/commands/show.ts';
const planned = (ticket: Partial<StubTicket> & { files: string[] }): StubTicket => ({
  state: 'unstarted',
  labels: ['planned', 'factory'],
  ...ticket,
});

test('the overlap stage names the open planned ticket whose plan changes a file the new plan changes', () => {
  const { code, output, calls } = runStage([SHOW, 'test/cli/show.test.ts'], {
    'FAKE-1': planned({ files: ['# Notes\n', planOf([`./${SHOW}`, 'src/other.ts'], '2026-11-01T09:00:00.000Z')] }),
    'FAKE-2': planned({ files: [planOf([SHOW], '2026-10-01T09:00:00.000Z')] }),
    'FAKE-5': planned({ files: [planOf(['src/elsewhere.ts'], '2026-11-05T09:00:00.000Z')] }),
    'FAKE-6': planned({ files: ['# Notes, and no plan\n'] }),
    'FAKE-7': { state: 'unstarted', labels: ['groom'], files: [planOf([SHOW], '2026-11-07T09:00:00.000Z')] },
    'FAKE-8': planned({ state: 'completed', files: [planOf([SHOW], '2026-11-08T09:00:00.000Z')] }),
  });
  expect(code).toBe(0);
  expect(output).toEqual({
    blockedBy: 'FAKE-1',
    why: `its plan also changes \`${SHOW}\``,
    shared: [SHOW],
    compared: [
      { ticketKey: 'FAKE-1', attachedAt: '2026-11-01T09:00:00.000Z', shared: [SHOW] },
      { ticketKey: 'FAKE-5', attachedAt: '2026-11-05T09:00:00.000Z', shared: [] },
    ],
    notes: ['FAKE-6: no plan attached'],
  });
  // The ticket itself, a ticket that is not planned and a ticket that is done are never read.
  expect(calls.filter((call) => call.startsWith('download ')).map((call) => call.split(' ')[1])).toEqual([
    'FAKE-1',
    'FAKE-5',
    'FAKE-6',
  ]);
  expect(calls.slice(0, 2)).toEqual(['list --state unstarted --label planned', 'list --state started --label planned']);
});

test('the overlap stage makes no port call for a plan that names no path but CONTEXT.md', () => {
  const { code, output, calls } = runStage(['CONTEXT.md'], {
    'FAKE-1': planned({ files: [planOf(['CONTEXT.md'], '2026-11-01T09:00:00.000Z')] }),
  });
  expect({ code, calls }).toEqual({ code: 0, calls: [] });
  expect(output).toEqual({ blockedBy: null, why: null, shared: [], compared: [], notes: ['the plan names no path'] });
});

test('of two overlapping tickets the overlap stage names the one whose plan was attached last, a started one included', () => {
  const { output } = runStage([SHOW], {
    'FAKE-1': planned({ files: [planOf([SHOW], '2026-11-01T09:00:00.000Z')] }),
    'FAKE-3': planned({ state: 'started', files: [planOf([SHOW], '2026-11-02T09:00:00.000Z')] }),
  });
  expect(output).toMatchObject({ blockedBy: 'FAKE-3', notes: [] });
  expect(output.compared.map((each: { ticketKey: string }) => each.ticketKey)).toEqual(['FAKE-1', 'FAKE-3']);
});

test('the overlap stage passes over a ticket that waits on this one, directly or through another, for the next', () => {
  const { output } = runStage([SHOW], {
    'FAKE-1': planned({ files: [planOf([SHOW], '2026-11-01T09:00:00.000Z')] }),
    // Waits on FAKE-2 through FAKE-9, which is open; FAKE-10 is unreadable and is not followed.
    'FAKE-3': planned({ files: [planOf([SHOW], '2026-11-03T09:00:00.000Z')], prerequisites: ['FAKE-10', 'FAKE-9'] }),
    'FAKE-4': planned({ files: [planOf([SHOW], '2026-11-04T09:00:00.000Z')], prerequisites: ['FAKE-2'] }),
    'FAKE-9': { state: 'started', labels: [], prerequisites: ['FAKE-3', 'FAKE-2'] },
  });
  expect(output).toMatchObject({
    blockedBy: 'FAKE-1',
    notes: ['FAKE-4: already waits on FAKE-2', 'FAKE-3: already waits on FAKE-2'],
  });
});

test('the overlap stage does not follow a prerequisite that is done', () => {
  const { output } = runStage([SHOW], {
    'FAKE-1': planned({ files: [planOf([SHOW], '2026-11-01T09:00:00.000Z')], prerequisites: ['FAKE-9'] }),
    'FAKE-9': { state: 'completed', labels: [], prerequisites: ['FAKE-2'] },
  });
  expect(output).toMatchObject({ blockedBy: 'FAKE-1', notes: [] });
});

test('the overlap stage passes over a ticket whose prerequisites run past 50 tickets', () => {
  const world: Record<string, StubTicket> = {
    'FAKE-1': planned({ files: [planOf([SHOW], '2026-11-01T09:00:00.000Z')], prerequisites: ['CHAIN-0'] }),
  };
  for (let index = 0; index < 60; index++) {
    world[`CHAIN-${index}`] = { state: 'unstarted', labels: [], prerequisites: [`CHAIN-${index + 1}`] };
  }
  world['CHAIN-60'] = { state: 'unstarted', labels: [] };
  const { output, calls } = runStage([SHOW], world);
  expect(output).toMatchObject({ blockedBy: null, notes: ['FAKE-1: its prerequisites run past 50 tickets'] });
  expect(calls.filter((call) => call.startsWith('get '))).toHaveLength(50);
  // Fifty processes: seconds on an idle machine, far longer on a loaded one.
}, 300_000);

test('the overlap stage fails when a port call fails, and prints no answer', () => {
  const { code, stderr, output } = runStage([SHOW], {
    'FAKE-1': planned({ files: [], refuses: true }),
  });
  expect(code).not.toBe(0);
  expect(stderr).toContain('sail port ticket-source download FAKE-1');
  expect(stderr).toContain('the provider is down');
  expect(output).toBeUndefined();
});
