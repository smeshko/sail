// The review workflow's attach-demonstration stage, run as a script on a run directory laid out as the engine lays it
// out, with a stub `sail` that records each port call it is asked for.
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempRepo } from '../helpers/temp-repo';

test('the stage attaches the transcript and screenshots a demonstrate call left in its $STAGE_OUT', async () => {
  await withTempRepo((repo) => {
    const run = join(repo.home, 'run');
    const demo = join(run, '04-demonstrate/call-1/out/demo');
    mkdirSync(demo, { recursive: true });
    writeFileSync(join(demo, 'transcript.txt'), '$ sail FAKE-1\n');
    writeFileSync(join(demo, 'run.png'), 'png');
    const callDir = join(run, '16-attach-demonstration/call-1');
    const out = join(callDir, 'out');
    const stageIn = join(callDir, 'in');
    mkdirSync(out, { recursive: true });
    mkdirSync(stageIn);
    const files = {
      INPUT_DEMONSTRATION: join(stageIn, 'demonstration.json'),
      INPUT_TICKETKEY: join(stageIn, 'ticketKey.txt'),
      INPUT_PR: join(stageIn, 'pr.json'),
    };
    writeFileSync(files.INPUT_DEMONSTRATION, JSON.stringify({ skipped: null, criteria: [], transcript: 'fallback' }));
    writeFileSync(files.INPUT_TICKETKEY, 'FAKE-1\n');
    writeFileSync(files.INPUT_PR, JSON.stringify({ number: 7, url: 'fake://codehost/sail/pull/7' }));
    const bin = join(repo.home, 'bin');
    mkdirSync(bin);
    const calls = join(repo.home, 'calls.txt');
    writeFileSync(join(bin, 'sail'), `#!/bin/sh\necho "$*" >> '${calls}'\necho '{"url":"fake://attachment"}'\n`);
    chmodSync(join(bin, 'sail'), 0o755);
    const child = Bun.spawnSync(
      [join(import.meta.dir, '../../.sail/workflows/review/stages/16-attach-demonstration/run.sh')],
      {
        cwd: repo.dir,
        env: { ...repo.env, ...files, PATH: `${bin}:${repo.env.PATH}`, SAIL_BUN: process.execPath, STAGE_OUT: out },
      },
    );
    expect(child.exitCode).toBe(0);
    const output = JSON.parse(child.stdout.toString());
    expect(output.attached.map((each: { name: string }) => each.name)).toEqual([
      'Demonstration transcript (demo)',
      'Demonstration: run.png (demo)',
    ]);
    expect(readFileSync(calls, 'utf8')).toContain(`--file ${join(demo, 'run.png')}`);
  });
});
