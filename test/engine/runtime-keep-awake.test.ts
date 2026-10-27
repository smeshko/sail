// The keep-awake a run holds: runWorkflow, runSeededWorkflow and resumeWorkflow acquire it before opening the run and
// release it once the run has ended, whatever the end, and report it once as `run:keep_awake`. A KeepAwake that
// snapshots the repository at each acquire and release shows when they happen.
import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { requestStop } from '../../src/engine/control';
import type { KeepAwake } from '../../src/engine/keep-awake';
import {
  type RunEnd,
  type RunWorkflowOptions,
  resumeWorkflow,
  runSeededWorkflow,
  runWorkflow,
} from '../../src/engine/runtime';
import { readEvents } from '../../src/events/consumers/ndjson';
import { fakeAdapters } from '../helpers/adapters';
import { edit } from '../helpers/fixture';
import { runIds, sharedSource } from '../helpers/seeded';
import { copyRun, writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const source = sharedSource();
afterAll(() => source.release());

interface Moment {
  at: 'acquire' | 'release';
  /** The runs the repository held then. */
  runs: number;
  /** The type of the last event of the newest run's stream then, if it has one. */
  lastEvent: string | undefined;
}

/** A keep-awake that records, at each acquire and release, what the repository held. */
function watching(repoDir: string, options: { reason?: string } = {}) {
  const moments: Moment[] = [];
  const snapshot = (at: Moment['at']) => {
    const ids = runIds(repoDir);
    const newest = ids.at(-1);
    const file = newest === undefined ? [] : readEvents(join(repoDir, '.sail-runs', newest));
    moments.push({ at, runs: ids.length, lastEvent: file.at(-1)?.type });
  };
  const keepAwake: KeepAwake = {
    acquire() {
      snapshot('acquire');
      const release = () => snapshot('release');
      return options.reason === undefined
        ? { held: true, by: 'fake', release }
        : { held: false, reason: options.reason, release };
    },
  };
  return { keepAwake, moments };
}

async function ran(cwd: string, options: Partial<RunWorkflowOptions>): Promise<RunEnd> {
  const end = await runWorkflow({
    cwd,
    adapters: await fakeAdapters(cwd),
    workflow: 'ticket-to-pr',
    ticket: 'FAKE-1',
    ...options,
  });
  if ('refused' in end) throw new Error(`refused: ${end.refused}`);
  return end;
}

const keepAwakeEvents = (dir: string) => readEvents(dir).filter((event) => event.type === 'run:keep_awake');
const typesOf = (dir: string) => readEvents(dir).map((event) => event.type);

test('a fresh run acquires before anything is written, releases after run:end, and reports one run:keep_awake between its opening and its intake', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const { keepAwake, moments } = watching(repo.dir);
    const end = await ran(repo.dir, { keepAwake });
    expect(end.status).toBe('completed');
    expect(moments).toEqual([
      { at: 'acquire', runs: 0, lastEvent: undefined },
      { at: 'release', runs: 1, lastEvent: 'run:end' },
    ]);
    const types = typesOf(end.dir);
    const awake = types.indexOf('run:keep_awake');
    expect(keepAwakeEvents(end.dir)).toEqual([
      expect.objectContaining({ type: 'run:keep_awake', held: true, by: 'fake' }),
    ]);
    expect(awake).toBeGreaterThan(types.lastIndexOf('workspace:created'));
    expect(awake).toBeGreaterThan(types.lastIndexOf('ticket:commented'));
    expect(awake).toBeLessThan(types.indexOf('intake:start'));
  });
});

test('a hold that is not held still runs the run to completed, and its event says why', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const { keepAwake } = watching(repo.dir, { reason: 'no keep-awake on linux' });
    const end = await ran(repo.dir, { keepAwake });
    expect(end.status).toBe('completed');
    expect(keepAwakeEvents(end.dir)).toEqual([
      expect.objectContaining({ held: false, reason: 'no keep-awake on linux' }),
    ]);
  });
});

test('the hold is released when a run is suspended by until, and its resume holds its own after the renewed lease', async () => {
  await withTempRepo(async (first) => {
    writeStub(first.dir);
    const fresh = watching(first.dir);
    const stopped = await ran(first.dir, { until: 'spec', keepAwake: fresh.keepAwake });
    expect(stopped).toMatchObject({ status: 'suspended', stopReason: 'until' });
    expect(fresh.moments.map((moment) => moment.at)).toEqual(['acquire', 'release']);
    await withTempRepo(async (second) => {
      copyRun(first.dir, second.dir);
      const again = watching(second.dir);
      const end = await resumeWorkflow({
        cwd: second.dir,
        adapters: await fakeAdapters(second.dir),
        runId: stopped.runId,
        keepAwake: again.keepAwake,
      });
      if ('refused' in end) throw new Error(end.refused);
      expect(end.status).toBe('completed');
      expect(again.moments).toEqual([
        { at: 'acquire', runs: 1, lastEvent: 'run:end' },
        { at: 'release', runs: 1, lastEvent: 'run:end' },
      ]);
      const types = typesOf(end.dir);
      const awake = types.map((type, index) => (type === 'run:keep_awake' ? index : -1)).filter((index) => index >= 0);
      expect(awake).toHaveLength(2);
      const resumedAt = awake[1] as number;
      expect(types[resumedAt - 1]).toBe('workspace:leased');
    });
  });
}, 60_000);

test('the hold is released when the run fails, stopped by its control file', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const { keepAwake, moments } = watching(repo.dir);
    const end = await ran(repo.dir, {
      keepAwake,
      onCall: (entry) => {
        if (entry.key === 'spec#1') requestStop(join(repo.dir, '.sail-runs', runIds(repo.dir)[0] ?? ''));
      },
    });
    expect(end).toMatchObject({ status: 'failed', stopReason: 'stopped' });
    expect(moments.map((moment) => moment.at)).toEqual(['acquire', 'release']);
    expect(moments[1]?.lastEvent).toBe('run:end');
  });
});

test('the hold is released when the run is interrupted before its first stage', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const { keepAwake, moments } = watching(repo.dir);
    const controller = new AbortController();
    const end = await ran(repo.dir, { keepAwake, signal: controller.signal, onCall: () => controller.abort() });
    expect(end).toMatchObject({ status: 'suspended', stopReason: 'interrupted' });
    expect(moments.map((moment) => moment.at)).toEqual(['acquire', 'release']);
    expect(moments[1]?.lastEvent).toBe('run:end');
  });
});

test('the hold is released when the open is refused, and no event is written', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const { keepAwake, moments } = watching(repo.dir);
    const end = await runWorkflow({
      cwd: repo.dir,
      adapters: await fakeAdapters(repo.dir),
      workflow: 'nope',
      ticket: 'FAKE-1',
      keepAwake,
    });
    expect(end).toEqual({ refused: expect.stringContaining('no workflow') });
    expect(moments).toEqual([
      { at: 'acquire', runs: 0, lastEvent: undefined },
      { at: 'release', runs: 0, lastEvent: undefined },
    ]);
  });
});

test('the hold is released when an exception inside sail propagates', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(
      sail,
      'workflows/ticket-to-pr/stages/spec/run.sh',
      "printf '# Spec",
      'echo not-json >>"$STAGE_OUT/../../journal.ndjson"\nprintf \'# Spec',
    );
    const { keepAwake, moments } = watching(repo.dir);
    await expect(ran(repo.dir, { keepAwake })).rejects.toThrow();
    expect(moments.map((moment) => moment.at)).toEqual(['acquire', 'release']);
    expect(moments[1]?.lastEvent).toBe('error:crash');
  });
});

test('a seeded run acquires and releases once, and reports its own run:keep_awake after its reused calls', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const { keepAwake, moments } = watching(repo.dir);
    const end = await runSeededWorkflow({
      cwd: repo.dir,
      fromRun: from.runId,
      stage: 'spec',
      adapters: await fakeAdapters(repo.dir),
      keepAwake,
    });
    if ('refused' in end) throw new Error(end.refused);
    expect(end).toMatchObject({ status: 'suspended', stopReason: 'until' });
    expect(moments.map((moment) => `${moment.at} ${moment.runs}`)).toEqual(['acquire 1', 'release 2']);
    expect(moments[1]?.lastEvent).toBe('run:end');
    const types = typesOf(end.dir);
    expect(types.filter((type) => type === 'run:keep_awake')).toHaveLength(1);
    expect(types.indexOf('run:keep_awake')).toBe(types.lastIndexOf('journal:append', types.indexOf('stage:start')) + 1);
  });
}, 60_000);
