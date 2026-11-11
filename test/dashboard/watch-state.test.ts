// A workflow's watch state is the live watcher's word, never its queue's last watch event, and the reason it gives is
// the one a refused queue change carries.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { findRepo } from '../../src/dashboard/files';
import { queueWatch, repoWatcher, workflowWatch } from '../../src/dashboard/watch-state';
import { betaWatcher, type Machine, seedFixtures } from '../helpers/dashboard';

let m: Machine;
beforeEach(() => {
  m = seedFixtures();
});
afterEach(() => m.remove());

const DEAD = 2 ** 22 + 12345;
const beta = () => {
  const entry = findRepo(m.registryDir, 'beta');
  if (entry === undefined) throw new Error('beta is registered');
  return entry;
};

test('with no watcher the workflow reads watcher not running, though its queue stream ends in watch:added', () => {
  expect(workflowWatch(beta(), 'ticket-to-pr')).toEqual({
    state: 'watcher not running',
    why: "no watcher is running for 'beta': sail watch ticket-to-pr first",
  });
});

test('a watcher whose pid is dead is no watcher', () => {
  betaWatcher(m, { pid: DEAD, sailDir: m.beta.sailDir });
  expect(workflowWatch(beta(), 'ticket-to-pr')).toEqual({
    state: 'watcher not running',
    why: "no watcher is running for 'beta': sail watch ticket-to-pr first",
  });
});

test('a live watcher in another clone is watcher not running, naming that clone, and its set is not read', () => {
  betaWatcher(m, { pid: process.pid, sailDir: m.alpha.sailDir });
  expect(workflowWatch(beta(), 'ticket-to-pr')).toEqual({
    state: 'watcher not running',
    why: `the watcher of 'beta' (pid ${process.pid}) runs in another clone: ${m.alpha.sailDir}`,
  });
  expect(repoWatcher(beta()).set).toEqual([]);
});

test('a live watcher that has removed the workflow does not watch it', () => {
  betaWatcher(m, { pid: process.pid, sailDir: m.beta.sailDir }, true);
  expect(workflowWatch(beta(), 'ticket-to-pr')).toEqual({
    state: 'not watched',
    why: `the watcher of 'beta' (pid ${process.pid}) does not watch 'ticket-to-pr': sail watch ticket-to-pr first`,
  });
});

test('a live watcher that watches the workflow says watched, naming itself and its label', () => {
  betaWatcher(m, { pid: process.pid, sailDir: m.beta.sailDir });
  const watch = workflowWatch(beta(), 'ticket-to-pr');
  expect(watch).toEqual({
    state: 'watched',
    named: `the watcher of 'beta' (pid ${process.pid})`,
    label: 'sail',
  });
  expect(queueWatch(watch)).toEqual({ state: 'watched' });
  expect(repoWatcher(beta()).set.map((each) => each.workflow)).toEqual(['ticket-to-pr']);
});

test('queueWatch keeps the reason of a state that is not watched', () => {
  expect(queueWatch({ state: 'not watched', why: 'because' })).toEqual({ state: 'not watched', why: 'because' });
});
