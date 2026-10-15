// A live run over the real server: the golden run's events appended to a running copy one at a time, while a client on
// `?run=` folds every message with the page's own run model. The cards appear in the golden run's call order, each one
// settled before the next appears, with the fix loop's two iterations, and the stream ends on `end`.
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEvent, emptyRun } from '../../src/dashboard/page/run-model';
import { type Dashboard, startDashboard } from '../../src/dashboard/server';
import { type Machine, RUNNING_ID, runningCopy, seedFixtures } from '../helpers/dashboard';

let m: Machine | undefined;
let server: Dashboard | undefined;
afterEach(async () => {
  await server?.stop();
  m?.remove();
});

async function until(condition: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(10);
  }
  return true;
}

test('a live run shows each card appear and settle in the golden order, the fix loop in iterations 1 and 2, and ends on end', async () => {
  m = seedFixtures();
  const { dir, rest } = runningCopy(m, 1);
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 10, indexPollMs: 1000 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const model = emptyRun();
  const kinds: string[] = [];
  /** After each event: every card as `key:state`. */
  const frames: string[][] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?run=alpha%2F${RUNNING_ID}`, {
    headers: { 'X-Sail-Dashboard': '1' },
  } as unknown as string[]);
  let closed: number | undefined;
  ws.onmessage = (message) => {
    const parsed = JSON.parse(String(message.data));
    kinds.push(parsed.kind);
    if (parsed.kind !== 'event') return;
    applyEvent(model, parsed.event);
    frames.push(model.cards.map((card) => `${card.key}:${card.state}`));
  };
  ws.onclose = (event) => {
    closed = event.code;
  };
  expect(await until(() => kinds.length === 1)).toBe(true);
  for (const [i, line] of rest.entries()) {
    if (i === rest.length - 1) writeFileSync(join(dir, 'STATUS'), 'completed\n');
    appendFileSync(join(dir, 'events.ndjson'), `${line}\n`);
    await Bun.sleep(10);
  }
  expect(await until(() => closed !== undefined)).toBe(true);
  expect([kinds.length, kinds.at(-1), closed]).toEqual([rest.length + 2, 'end', 1000]);

  const order = model.cards.map((card) => card.key);
  expect(order).toEqual([
    'intake#1',
    'spec#1',
    'implement#1',
    'tests#1',
    'implement#2',
    'tests#2',
    'self-review#1',
    'describe#1',
    'open#1',
  ]);
  // Each card appears running, and has settled by the frame where the next one appears.
  for (const [i, key] of order.entries()) {
    const appeared = frames.findIndex((frame) => frame.length === i + 1);
    expect(frames[appeared]?.at(-1)).toBe(`${key}:running`);
    const next = frames.findIndex((frame) => frame.length === i + 2);
    if (next >= 0) expect(frames[next - 1]?.[i]).toBe(`${key}:settled`);
  }
  expect(model.cards.map((card) => card.iteration?.iteration ?? 0)).toEqual([0, 0, 1, 1, 2, 2, 2, 0, 0]);
  expect(model.end).toEqual({ status: 'completed' });
}, 30_000);
