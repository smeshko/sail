// The Bash gate against real bash (review R2-1 to R2-4): seeded random commands, built from the forms rounds 1 and 2
// of the review got past it, go to the gate, and each one it allows runs under /bin/bash with stub commands. Bash is
// the reference: an allowed command must leave no job running after bash exits, run no other shell, and hand git diff
// no --no-index and no operand outside the worktree.
import { afterAll, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGate } from '../../../src/adapters/claude-code/gate';

const base = mkdtempSync(join(tmpdir(), 'sail-command-check-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const [stageIn, stageOut] = ['in', 'out'].map((name) => join(base, name)) as [string, string];
for (const dir of [stageIn, stageOut]) mkdirSync(dir, { recursive: true });

/** Where one worker's commands run: its own worktree, stubs, log and git argument files, so workers never meet. */
interface Box {
  readonly work: string;
  readonly stubs: string;
  readonly gits: string;
  readonly log: string;
}

/** Each stub logs to its own box by a path written into it: `env -i` would clear a variable naming the box. */
function box(name: string): Box {
  const [work, stubs, gits] = ['work', 'bin', 'gits'].map((each) => join(base, name, each)) as [string, string, string];
  for (const dir of [work, stubs, gits]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(work, 'README.md'), 'readme\n');
  const log = join(base, name, 'log');
  /** A stub command: a bash script, so it runs whatever PATH the command under test has. */
  const stub = (command: string, body: string): void => {
    writeFileSync(join(stubs, command), `#!/bin/bash\n${body}\n`);
    chmodSync(join(stubs, command), 0o755);
  };
  stub('sleep', `echo "sleep $$" >> ${log}; exec /bin/sleep 0.3`);
  stub('git', `printf '%s\\0' "$@" > ${gits}/$$-$RANDOM`);
  for (const shell of ['zsh', 'sh', 'dash', 'ksh', 'fish']) stub(shell, `echo "shell ${shell}" >> ${log}`);
  for (const command of ['bash', 'env', 'nohup', 'xargs', 'find', 'cat', 'true']) {
    const real = Bun.which(command, { PATH: '/bin:/usr/bin' });
    if (real !== null) symlinkSync(real, join(stubs, command));
  }
  return { work, stubs, gits, log };
}

/** The allowed commands run this many at a time, each worker in its own box. */
const WORKERS = 8;
const boxes = Array.from({ length: WORKERS }, (_, at) => box(`box-${at}`));
const work = boxes[0]?.work ?? '';

const gate = createGate({
  permissions: { read: ['**'], write: ['**'], commands: ['*'] },
  ctx: { worktree: work, stageIn, stageOut, env: { STAGE_IN: stageIn, STAGE_OUT: stageOut } },
});

const ATOMS = [
  'sleep 1',
  'git log -1',
  'git diff HEAD',
  'git diff HEAD -- README.md',
  'git diff /dev/null /etc/hosts',
  'git diff ../x README.md',
  'git diff --no-index a b',
  'git diff --no-i\\ndex a b',
  'git diff "--no-"index a b',
  'X=--no-index; git diff $X a b',
  'echo /etc/hosts | xargs git diff /dev/null',
  'find . -name README.md -exec git diff /dev/null {} \\;',
  'zsh -c true',
  'z\\sh -c true',
  '"zs"h -c true',
  "'zsh' -c true",
  'sh -c true',
  '/bin/zsh -c true',
  'env zsh -c true',
  'env -i sleep 1',
  'nohup sleep 1',
  'echo hi',
  'cat README.md',
  'true',
];
const JOINS = [' && ', ' ; ', ' | ', ' || ', ' & ', ' \\& ', '\n', ';'];
const ENDS = ['', '', '', ' &', ' 2>&1', ' &>/dev/null', ' \\>&', ' >&2', ' > out.txt', ' \\&'];

/** mulberry32: the same commands on every run. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sq = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const dq = (text: string) => `"${text.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
const escaped = (text: string) => text.replace(/[^A-Za-z0-9_\-./=]/g, (c) => `\\${c}`);

function command(rand: () => number, depth: number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const parts = [pick(ATOMS) + pick(ENDS)];
  while (rand() < 0.4) parts.push(pick(ATOMS) + pick(ENDS));
  const text = parts.reduce((all, part) => `${all}${pick(JOINS)}${part}`);
  if (depth === 0 || rand() < 0.4) return text;
  const inner = command(rand, depth - 1);
  const wrapped = pick([
    `bash -c ${sq(inner)}`,
    `bash -c ${dq(inner)}`,
    `bash -c ${escaped(inner)}`,
    `echo $(${inner})`,
    `echo "$(${inner})"`,
    `eval ${sq(inner)}`,
    `cat <<EOF\n$(${inner})\nEOF`,
  ]);
  return rand() < 0.5 ? wrapped : `${text}${pick(JOINS)}${wrapped}`;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** What `text` did under bash that the gate should have refused. */
async function underBash(text: string, { work, stubs, gits, log }: Box): Promise<string[]> {
  writeFileSync(log, '');
  for (const file of readdirSync(gits)) rmSync(join(gits, file));
  const run = Bun.spawn(['/bin/bash', '-c', text], {
    cwd: work,
    env: { PATH: stubs, HOME: base },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const timer = setTimeout(() => run.kill('SIGKILL'), 8_000);
  await run.exited;
  clearTimeout(timer);
  const problems = new Set<string>();
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (line.startsWith('shell ')) problems.add(`ran ${line.slice(6)}`);
    const pid = line.startsWith('sleep ') ? Number(line.slice(6)) : 0;
    if (pid > 0 && alive(pid)) {
      problems.add('a job outlived bash');
      process.kill(pid, 'SIGKILL');
    }
  }
  for (const file of readdirSync(gits)) {
    const argv = readFileSync(join(gits, file), 'utf8').split('\0').slice(0, -1);
    const at = argv.indexOf('diff');
    const outside = (arg: string) =>
      arg.startsWith('--no-index') || arg.startsWith('/') || arg.split('/').includes('..');
    if (at !== -1 && argv.slice(at + 1).some(outside)) problems.add(`git got ${JSON.stringify(argv)}`);
  }
  return [...problems];
}

test('no command the gate allows does under bash what the gate refuses: 600 seeded commands', async () => {
  const rand = random(108);
  const signal = new AbortController().signal;
  const allowed: string[] = [];
  for (let i = 0; i < 600; i++) {
    const text = command(rand, 2);
    const answer = (await gate.preToolUse(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '',
        cwd: work,
        tool_name: 'Bash',
        tool_input: { command: text },
        tool_use_id: `t${i}`,
      },
      undefined,
      { signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    if (answer.hookSpecificOutput?.permissionDecision === 'allow') allowed.push(text);
  }
  const escapes: string[] = [];
  let next = 0;
  await Promise.all(
    boxes.map(async (each) => {
      for (let at = next++; at < allowed.length; at = next++) {
        const text = allowed[at] ?? '';
        const problems = await underBash(text, each);
        if (problems.length > 0) escapes.push(`${JSON.stringify(text)}: ${problems.join('; ')}`);
      }
    }),
  );
  expect({ ranSome: allowed.length >= 30, escapes }).toEqual({ ranSome: true, escapes: [] });
}, 120_000);
