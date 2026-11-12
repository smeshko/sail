// Preload the launcher passes to `bun test` while its silence watchdog is on. `bun test` prints a file only when it
// ends, and a worker blocked in a synchronous call never ends it, so each worker writes a marker naming its test file
// when the file starts and removes it when the file ends. The watchdog reads the markers when it stops a run.
import { afterAll } from 'bun:test';
import { markEnded, markStarted, RUNNING_ENV } from './test-watchdog';

const dir = process.env[RUNNING_ENV];
const file = Bun.main;
markStarted(dir, process.pid, file);
afterAll(() => markEnded(dir, process.pid, file));
