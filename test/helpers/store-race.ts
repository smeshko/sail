// Drives one interleaving of the fake store's lock deterministically: run A finds a lock whose holder has died, and the
// moment A has read it, B breaks that lock and takes it. Should A then move the lock aside, C takes the empty path the
// moment it is empty. Prints how A's change ended, and whom the lock names after: B, unless B's lock was lost.
//
//   bun test/helpers/store-race.ts <dir>
//
// test/adapters/fake/store.test.ts spawns it, so the patched module never reaches the test process.
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';

const [dir] = process.argv.slice(2) as [string];
const lock = join(dir, 'state.json.lock');

// B and C stand for live processes other than this one, and the lock's first holder has died.
const b = Bun.spawn(['sleep', '30']);
const c = Bun.spawn(['sleep', '30']);
const dead = Bun.spawn(['true']);
await dead.exited;

let afterRead: (() => void) | undefined;
let afterMove: (() => void) | undefined;
// Taken before the patch, which replaces the namespace's bindings in place.
const read = fs.readFileSync;
const rename = fs.renameSync;
const readFileSync = (...args: Parameters<typeof fs.readFileSync>) => {
  const text = read(...args);
  const then = afterRead;
  if (then !== undefined && args[0] === lock) {
    afterRead = undefined;
    then();
  }
  return text;
};
const renameSync = (...args: Parameters<typeof fs.renameSync>) => {
  rename(...args);
  const then = afterMove;
  if (then !== undefined && args[0] === lock) {
    afterMove = undefined;
    then();
  }
};
const patched = { ...fs, readFileSync, renameSync };
mock.module('node:fs', () => ({ ...patched, default: patched }));

const { createStore } = await import('../../src/adapters/fake/store');
const { z } = await import('zod');

fs.writeFileSync(join(dir, 'seed.json'), '{ "count": 0 }\n');
fs.writeFileSync(lock, `${dead.pid}\n`);
const store = createStore({
  seed: join(dir, 'seed.json'),
  state: join(dir, 'state.json'),
  schema: z.object({ count: z.number() }),
  port: 'ticketSource',
  lockWaitMs: 50,
});

afterRead = () => {
  fs.rmSync(lock);
  fs.writeFileSync(lock, `${b.pid}\n`);
};
afterMove = () => fs.writeFileSync(lock, `${c.pid}\n`, { flag: 'wx' });
let a: string;
try {
  store.change((world) => {
    world.count++;
  });
  a = 'changed';
} catch (error) {
  a = (error as { code?: string }).code ?? String(error);
}
const holder = Number(read(lock, 'utf8').trim());
console.log(JSON.stringify({ a, lock: holder === b.pid ? 'B' : holder === c.pid ? 'C' : String(holder) }));
b.kill();
c.kill();
