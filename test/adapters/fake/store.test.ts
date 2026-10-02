// A file-backed fake's store (D1): a change holds the state file's lock from its read to its write, so changes made in
// several processes at once each see the one before. A lock a dead process left is broken, and a live one waited on.
import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createStore } from '../../../src/adapters/fake/store';
import { createFakeTicketSource } from '../../../src/adapters/fake/ticket-source';
import { caught, messageOf, portFailure } from '../../helpers/ports';

const TICKET_SOURCE = join(import.meta.dir, '..', '..', '..', 'src', 'adapters', 'fake', 'ticket-source.ts');
const SEED = join(import.meta.dir, '..', '..', 'fixtures', 'repo', '.sail', 'fake', 'tickets.json');
const RACE = join(import.meta.dir, '..', '..', 'helpers', 'store-race.ts');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-fake-store-'));
  dirs.push(dir);
  return dir;
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true']);
  await child.exited;
  return child.pid;
}

const Counter = z.object({ count: z.number().int() });

/** A store over a seed holding `{ count: 0 }`, whose state file's folder exists. */
function counter(lockWaitMs?: number) {
  const dir = tempDir();
  const seed = join(dir, 'seed.json');
  writeFileSync(seed, '{ "count": 0 }\n');
  const state = join(dir, 'state', 'count.json');
  mkdirSync(join(dir, 'state'));
  const store = createStore({
    seed,
    state,
    schema: Counter,
    port: 'ticketSource',
    ...(lockWaitMs === undefined ? {} : { lockWaitMs }),
  });
  return { store, state, lock: `${state}.lock` };
}

test('claims and comments made by several processes at once: exactly one claim takes, and no comment is lost', async () => {
  const dir = tempDir();
  const world = { seed: join(dir, 'tickets.json'), state: join(dir, 'state', 'tickets.json') };
  copyFileSync(SEED, world.seed);
  // Every racer waits for the same instant, then claims FAKE-1 and comments on FAKE-3.
  const at = Date.now() + 500;
  const racer = (n: number) =>
    Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { createFakeTicketSource } = await import(${JSON.stringify(TICKET_SOURCE)});
         const source = createFakeTicketSource(${JSON.stringify(world)});
         while (Date.now() < ${at});
         const { claimed } = await source.claim('FAKE-1');
         await source.comment('FAKE-3', 'racer ${n}');
         console.log(JSON.stringify({ claimed }));`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
  const racers = [1, 2, 3, 4, 5, 6].map(racer);
  const outputs = await Promise.all(
    racers.map(async (child) => ({
      code: await child.exited,
      stdout: (await new Response(child.stdout).text()).trim(),
      stderr: (await new Response(child.stderr).text()).trim(),
    })),
  );
  expect(outputs.map(({ code, stderr }) => ({ code, stderr }))).toEqual(racers.map(() => ({ code: 0, stderr: '' })));
  const claims = outputs.map(({ stdout }) => (JSON.parse(stdout) as { claimed: boolean }).claimed);
  expect(claims.filter(Boolean)).toHaveLength(1);

  const source = createFakeTicketSource(world);
  expect((await source.get('FAKE-1')).state).toEqual({ type: 'started', name: 'In Progress' });
  const bodies = (await source.get('FAKE-3')).comments.map((comment) => comment.body);
  expect(bodies.filter((body) => body.startsWith('racer ')).sort()).toEqual([
    'racer 1',
    'racer 2',
    'racer 3',
    'racer 4',
    'racer 5',
    'racer 6',
  ]);
  expect(existsSync(`${world.state}.lock`)).toBe(false);
});

test('a lock left by a process that died holding it is taken over, and the change lands', async () => {
  const { store, state, lock } = counter();
  writeFileSync(lock, `${await deadPid()}\n`);
  expect(
    store.change((world) => {
      world.count++;
      return 'changed';
    }),
  ).toBe('changed');
  expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual({ count: 1 });
  expect(existsSync(lock)).toBe(false);
});

test("breaking a dead holder's lock never touches a live one: a lock taken meanwhile is still its taker's", async () => {
  const child = Bun.spawn([process.execPath, RACE, tempDir()], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({ a: 'unavailable', lock: 'B' });
});

test('a breaker left by a process that died breaking stops the dead lock being broken, and the change is unavailable', async () => {
  const { store, state, lock } = counter(20);
  const pid = `${await deadPid()}\n`;
  writeFileSync(lock, pid);
  writeFileSync(`${lock}.break`, pid);
  expect(portFailure(caught(() => store.change(() => undefined)))).toEqual({
    port: 'ticketSource',
    op: 'change',
    code: 'unavailable',
  });
  expect([readFileSync(lock, 'utf8'), existsSync(`${lock}.break`), existsSync(state)]).toEqual([pid, true, false]);
});

test('a lock a live process holds is waited on, then the change fails as unavailable, naming the lock and its pid', () => {
  const { store, state, lock } = counter(50);
  writeFileSync(lock, `${process.pid}\n`);
  const started = Date.now();
  const error = caught(() =>
    store.change((world) => {
      world.count++;
    }),
  );
  expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'change', code: 'unavailable' });
  expect(messageOf(error)).toContain(`${lock} is held by pid ${process.pid}`);
  expect([existsSync(state), readFileSync(lock, 'utf8')]).toEqual([false, `${process.pid}\n`]);
});

test('a lock that names no pid is held all the same: nothing is taken over that might be mid-change', () => {
  const { store, lock } = counter(20);
  writeFileSync(lock, 'not a pid');
  expect(portFailure(caught(() => store.change(() => undefined)))).toEqual({
    port: 'ticketSource',
    op: 'change',
    code: 'unavailable',
  });
  expect(readFileSync(lock, 'utf8')).toBe('not a pid');
});

test('a change that throws writes nothing and releases the lock', () => {
  const { store, state, lock } = counter();
  const error = caught(() =>
    store.change((world) => {
      world.count++;
      throw new Error('no such ticket');
    }),
  );
  expect([messageOf(error), existsSync(state), existsSync(lock)]).toEqual(['no such ticket', false, false]);
});
