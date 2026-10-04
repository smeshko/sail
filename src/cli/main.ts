#!/usr/bin/env bun
import { run } from './index';
import { detectTty } from './tty';

const tty = detectTty(process.stdout, process.env);

process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  onInterrupt: (handler) => {
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
    return () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    };
  },
  env: process.env,
  ...(tty === undefined ? {} : { tty }),
});
