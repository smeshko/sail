// The CLI commands the page shows to copy, since the dashboard controls nothing (D11). A run id, a workflow and a dedup
// key come from run and queue files, so one that isn't a plain word is quoted: a pasted command runs only what it says.
import { expect, test } from 'bun:test';
import { parkedCommands, runCommands } from '../../../src/dashboard/page/commands';

const RUN = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';

test('runCommands gives sail show always, --follow while the run runs, and sail resume once it is suspended', () => {
  const commands = (status: string) => runCommands(RUN, status).map(({ label, command }) => `${label}: ${command}`);
  expect(commands('running')).toEqual([`show: sail show ${RUN}`, `follow: sail show ${RUN} --follow`]);
  expect(commands('suspended')).toEqual([`show: sail show ${RUN}`, `resume: sail resume ${RUN}`]);
  expect(commands('completed')).toEqual([`show: sail show ${RUN}`]);
  expect(commands('failed')).toEqual([`show: sail show ${RUN}`]);
});

test('parkedCommands gives requeue and drop, and a word that is not plain is single-quoted for the shell', () => {
  expect(parkedCommands('ticket-to-pr', 'ticket:FAKE-6')).toEqual([
    { label: 'requeue', command: 'sail queue requeue ticket-to-pr ticket:FAKE-6' },
    { label: 'drop', command: 'sail queue drop ticket-to-pr ticket:FAKE-6' },
  ]);
  expect(runCommands('FAKE-1; rm -rf ~', 'completed')).toEqual([
    { label: 'show', command: "sail show 'FAKE-1; rm -rf ~'" },
  ]);
  expect(parkedCommands('wf', "ticket:it's $(id)").map(({ command }) => command)).toEqual([
    "sail queue requeue wf 'ticket:it'\\''s $(id)'",
    "sail queue drop wf 'ticket:it'\\''s $(id)'",
  ]);
});
