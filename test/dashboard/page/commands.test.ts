// The CLI commands the page shows to copy for a run. A run id comes from run files, so one that isn't a plain word is quoted: a pasted command runs only what it says.
import { expect, test } from 'bun:test';
import { runCommands } from '../../../src/dashboard/page/commands';

const RUN = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';

test('runCommands gives sail show always, --follow while the run runs, and sail resume once it is suspended', () => {
  const commands = (status: string) => runCommands(RUN, status).map(({ label, command }) => `${label}: ${command}`);
  expect(commands('running')).toEqual([`show: sail show ${RUN}`, `follow: sail show ${RUN} --follow`]);
  expect(commands('suspended')).toEqual([`show: sail show ${RUN}`, `resume: sail resume ${RUN}`]);
  expect(commands('completed')).toEqual([`show: sail show ${RUN}`]);
  expect(commands('failed')).toEqual([`show: sail show ${RUN}`]);
});

test('a run id that is not a plain word is single-quoted for the shell', () => {
  expect(runCommands('FAKE-1; rm -rf ~', 'completed')).toEqual([
    { label: 'show', command: "sail show 'FAKE-1; rm -rf ~'" },
  ]);
});
