import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IntakeEntry, ScriptRef, StageEntry } from '../../src/engine/definitions';
import { portCallProblems } from '../../src/engine/port-calls';

function sailDir(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'sail-ports-')), '.sail');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function stageEntry(
  dir: string,
  folder: string,
  scripts: { step: string; run: string; ports: string[] }[],
): StageEntry {
  return {
    name: 'demo',
    kind: scripts.length > 1 ? 'stage' : 'script',
    steps: [],
    workflow: null,
    file: join(dir, folder, 'stage.ts'),
    scripts: scripts.map((s): ScriptRef => ({ ...s, run: join(dir, folder, s.run) })),
  };
}

const messages = (dir: string, stages: StageEntry[], intakes: IntakeEntry[] = []) =>
  portCallProblems(dir, { stages, intakes }).map((p) => p.message);

test('an undeclared shell call names the step, the file, the line and the port to add', () => {
  const dir = sailDir({ 'stages/demo/run.sh': '#!/bin/sh\nset -e\nsail port codehost push "$B" >/dev/null\n' });
  const entry = stageEntry(dir, 'stages/demo', [{ step: 'open', run: 'run.sh', ports: ['ticket-source'] }]);
  expect(portCallProblems(dir, { stages: [entry], intakes: [] })).toEqual([
    {
      file: entry.file,
      message:
        "step open calls sail port codehost at stages/demo/run.sh:3, and its ports don't name it: add 'codehost' to its ports",
    },
  ]);
});

test('an undeclared call in the JavaScript array form is reported', () => {
  const dir = sailDir({
    'stages/demo/run.mjs':
      "import { spawnSync } from 'node:child_process';\nspawnSync('sail', ['port', 'jev', 'ask']);\n",
  });
  const entry = stageEntry(dir, 'stages/demo', [{ step: 'ask', run: 'run.mjs', ports: [] }]);
  expect(messages(dir, [entry])).toEqual([
    "step ask calls sail port jev at stages/demo/run.mjs:2, and its ports don't name it: add 'jev' to its ports",
  ]);
});

test('a declared call is not reported', () => {
  const dir = sailDir({ 'stages/demo/run.sh': 'sail port codehost push x\nsail port ticket-source get y\n' });
  const entry = stageEntry(dir, 'stages/demo', [{ step: 'open', run: 'run.sh', ports: ['ticket-source', 'codehost'] }]);
  expect(messages(dir, [entry])).toEqual([]);
});

test('comment lines and the render subcommand are not calls', () => {
  const dir = sailDir({
    'stages/demo/run.sh': '# sail port codehost push\nsail render tpl\nsail port render x\n',
    'stages/demo/run.mjs': "// spawnSync('sail', ['port', 'codehost'])\n/* sail port jev */\n * sail port jev\n",
  });
  const sh = stageEntry(dir, 'stages/demo', [{ step: 'a', run: 'run.sh', ports: [] }]);
  const mjs = stageEntry(dir, 'stages/demo', [{ step: 'b', run: 'run.mjs', ports: [] }]);
  expect(messages(dir, [sh])).toEqual([]);
  expect(messages(dir, [mjs])).toEqual([]);
});

test('a literal call of a name that is no port is reported', () => {
  const dir = sailDir({ 'stages/demo/run.sh': 'sail port tracker get X\n' });
  const entry = stageEntry(dir, 'stages/demo', [{ step: 'open', run: 'run.sh', ports: ['codehost'] }]);
  expect(messages(dir, [entry])).toEqual([
    'step open calls sail port tracker at stages/demo/run.sh:1, which is no port: ticket-source, codehost or jev',
  ]);
});

test('a dynamic call is not reported', () => {
  const dir = sailDir({
    'stages/demo/run.sh': 'sail port "$P" get X\nsail port $P get X\nsail port $' + '{P} get\n',
    'stages/demo/run.mjs': "spawnSync('sail', ['port', ...args]);\nspawnSync('sail', ['port', name]);\n",
  });
  const sh = stageEntry(dir, 'stages/demo', [{ step: 'a', run: 'run.sh', ports: [] }]);
  const mjs = stageEntry(dir, 'stages/demo', [{ step: 'b', run: 'run.mjs', ports: [] }]);
  expect(messages(dir, [sh, mjs])).toEqual([]);
});

test('a call in a lib helper the run file references is reported against the step that reaches it', () => {
  const dir = sailDir({
    'stages/demo/run.sh': '#!/bin/sh\n"$(dirname "$SAIL_CONFIG")/lib/push.sh"\n',
    'project.yaml': '',
    'lib/push.sh': 'sail port codehost push "$BRANCH"\n',
  });
  const entry = stageEntry(dir, 'stages/demo', [{ step: 'open', run: 'run.sh', ports: [] }]);
  expect(messages(dir, [entry])).toEqual([
    "step open calls sail port codehost at lib/push.sh:1, and its ports don't name it: add 'codehost' to its ports",
  ]);
});

test('each script step of a multi-step stage is checked against its own ports', () => {
  const dir = sailDir({
    'stages/demo/one.sh': 'sail port codehost push x\n',
    'stages/demo/two.sh': 'sail port codehost push y\n',
  });
  const entry = stageEntry(dir, 'stages/demo', [
    { step: 'one', run: 'one.sh', ports: ['codehost'] },
    { step: 'two', run: 'two.sh', ports: ['jev'] },
  ]);
  expect(messages(dir, [entry])).toEqual([
    "step two calls sail port codehost at stages/demo/two.sh:1, and its ports don't name it: add 'codehost' to its ports",
  ]);
});

test('a script file in the definition folder is checked against the union of its steps ports', () => {
  const dir = sailDir({
    'stages/demo/one.sh': 'true\n',
    'stages/demo/helper.sh': 'sail port codehost push x\nsail port jev ask\n',
    'stages/demo/notes.md': 'sail port tracker get\n',
  });
  const entry = stageEntry(dir, 'stages/demo', [{ step: 'one', run: 'one.sh', ports: ['codehost'] }]);
  expect(messages(dir, [entry])).toEqual([
    'stages/demo/helper.sh:2 calls sail port jev, and no script step of demo names it in its ports',
  ]);
});

test('an intake script step is checked like a stage step', () => {
  const dir = sailDir({ 'workflows/w/fetch.sh': 'sail port ticket-source get X\n' });
  const intake: IntakeEntry = {
    name: 'mine',
    workflow: 'w',
    file: join(dir, 'workflows/w/intake.ts'),
    scripts: [{ step: 'fetch', run: join(dir, 'workflows/w/fetch.sh'), ports: [] }],
  };
  expect(messages(dir, [], [intake])).toEqual([
    "step fetch calls sail port ticket-source at workflows/w/fetch.sh:1, and its ports don't name it: add 'ticket-source' to its ports",
  ]);
});

test('a reference the reader cannot resolve is passed through as a problem', () => {
  const dir = sailDir({ 'stages/demo/run.sh': '"$sail_dir/lib/gone.sh"\n' });
  const entry = stageEntry(dir, 'stages/demo', [{ step: 'a', run: 'run.sh', ports: [] }]);
  expect(portCallProblems(dir, { stages: [entry], intakes: [] })).toEqual([
    {
      file: join(dir, 'stages/demo/run.sh'),
      message: `references ${join(dir, 'lib/gone.sh')}, which resolves to no file`,
    },
  ]);
});
