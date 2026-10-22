// `sail FAKE-1 --record <dir>` and `sail resume <run> --record <dir>` (11.3 D10), offline: a copy of the fixture
// repository whose harness is the built-in claude-code on a scripted query(), so the recording holds the messages a real
// session sends, tool results included. The recording is then played back through the fake harness in a second copy with
// no credential in its environment, and the two runs must agree on keys, outcomes, outputs and produced files.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Recording } from '../../src/adapters/recording';
import { EXIT_REFUSED, EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { readJournal } from '../../src/engine/journal';
import { runDirIn } from '../helpers/agent-fixture';
import {
  assistantText,
  assistantToolUse,
  done,
  init,
  resultSuccess,
  SESSION_ID,
  type Stream,
  writeScriptedClaudeCode,
  writeScriptedStreams,
} from '../helpers/claude-code';
import { copyFixture, FIXTURE_SAIL } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { copyRun } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

/** The OAuth token of the test: 40 characters of the shapes a real one has, which the scripted sessions echo. */
const TOKEN = 'sk-ant-oat01-Tq7Zk3b9QfVwX7mLp2RtYh8N';
const KEYS = ['spec#1', 'implement#1', 'implement#2', 'self-review#1', 'describe#1'];
/** The fake harness's script for the fixture: the answers the scripted sessions submit, in the order the run asks. */
const SCRIPT = JSON.parse(readFileSync(join(FIXTURE_SAIL, 'fake', 'harness.json'), 'utf8')) as Record<
  string,
  { output: unknown; files?: Record<string, string>; messages?: string[] }[]
>;
const answerOf = (key: string) => (SCRIPT[key] ?? SCRIPT[key.replace(/#\d+/, '')] ?? [])[0];

/** The tool result of call `callId`, carrying `text`. */
const toolResultOf = (callId: string, text: string): SDKUserMessage =>
  ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: text, is_error: false }] },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  }) as SDKUserMessage;

/** One session for `key`: it echoes the token and the repository's path, writes its files and submits its output. */
function session(key: string, index: number, repoDir: string): Stream {
  const answer = answerOf(key);
  const sessionId = `cc-session-${index + 1}`;
  return [
    init({ sessionId }),
    assistantText('m0', `Working in ${repoDir} with ${TOKEN}.`, { usage: { input: 10, output: 5 } }),
    assistantToolUse('m1', `tool-${index}`, 'Bash', { command: `echo ${TOKEN} in ${repoDir}` }),
    toolResultOf(`tool-${index}`, `ran in ${repoDir}: ${TOKEN}`),
    ...Object.entries(answer?.files ?? {}).map(([file, text]) => ({ act: 'write' as const, file, text })),
    ...(answer?.messages ?? []).map((text, n) =>
      assistantText(`m${n + 2}`, text, { usage: { input: 20, output: 30 } }),
    ),
    resultSuccess({ sessionId, structured: done(answer?.output) }),
  ];
}

const streamsFor = (repoDir: string): Stream[] => KEYS.map((key, index) => session(key, index, repoDir));

/** Every file in `dir`, by name. */
const filesOf = (dir: string): Record<string, string> =>
  Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));

/** A run's journal as the comparison reads it: the keys, outcomes, outputs and produced files' hashes. */
const journalOf = (runDir: string) =>
  readJournal(runDir).entries.map(({ key, outcome, output, files }) => ({ key, outcome, output, files }));

/** `journal.txt` as a run's journal says it: a `<key> <outcome>` line per entry. */
const journalLines = (runDir: string): string =>
  readJournal(runDir)
    .entries.map(({ key, outcome }) => `${key} ${outcome}\n`)
    .join('');

interface Scenario {
  record: {
    code: number;
    stderr: string;
    files: Record<string, string>;
    repoDir: string;
    realDir: string;
    journal: string;
  };
  recordedRun: ReturnType<typeof journalOf>;
  plain: ReturnType<typeof journalOf>;
  playback: { code: number; stderr: string; journal: ReturnType<typeof journalOf> };
}

let cached: Promise<Scenario> | undefined;

/** The same run three ways: unrecorded, recorded, and played back from the recording. Run once, read by every case. */
function scenario(): Promise<Scenario> {
  cached ??= (async (): Promise<Scenario> => {
    const plain = await withTempRepo(async (repo) => {
      copyFixture(repo.dir);
      writeScriptedClaudeCode(repo.dir, streamsFor(repo.dir));
      const ended = await runCaptured(['FAKE-1', '-q'], repo.dir, {
        env: { ...repo.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      });
      expect(ended.code).toBe(0);
      return journalOf(runDirIn(repo.dir));
    });
    const recorded = await withTempRepo(async (repo) => {
      copyFixture(repo.dir);
      writeScriptedClaudeCode(repo.dir, streamsFor(repo.dir));
      const ended = await runCaptured(['FAKE-1', '-q', '--record', 'rec'], repo.dir, {
        env: { ...repo.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      });
      return {
        record: {
          code: ended.code,
          stderr: ended.stderr,
          files: filesOf(join(repo.dir, 'rec')),
          repoDir: repo.dir,
          realDir: realpathSync(repo.dir),
          journal: journalLines(runDirIn(repo.dir)),
        },
        recordedRun: journalOf(runDirIn(repo.dir)),
      };
    });
    const replayed = await withTempRepo(async (repo) => {
      const sail = copyFixture(repo.dir);
      const rec = join(sail, 'rec');
      mkdirSync(rec);
      for (const [name, text] of Object.entries(recorded.record.files)) writeFileSync(join(rec, name), text);
      const config = join(sail, 'project.yaml');
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace('harness: { use: fake }', 'harness: { use: fake, playback: ./rec }'),
      );
      // No credential: only the temp repository's own environment.
      const ended = await runCaptured(['FAKE-1', '-q'], repo.dir, { env: repo.env });
      return { code: ended.code, stderr: ended.stderr, journal: journalOf(runDirIn(repo.dir)) };
    });
    return { ...recorded, plain, playback: replayed };
  })();
  return cached;
}

test('sail FAKE-1 --record rec completes and writes one recording per agent call key, plus journal.txt', async () => {
  const { record } = await scenario();
  expect({ code: record.code, stderr: record.stderr }).toEqual({ code: 0, stderr: '' });
  expect(Object.keys(record.files).sort()).toEqual([...KEYS.map((key) => `${key}.json`), 'journal.txt'].sort());
  expect(record.files['journal.txt']).toBe(record.journal);
});

test('each recording holds the events, the provider messages with a tool result, the output, usage and produced files', async () => {
  const { record } = await scenario();
  for (const [index, key] of KEYS.entries()) {
    const recording = Recording.parse(JSON.parse(record.files[`${key}.json`] ?? 'null'));
    const [recorded] = recording.tries;
    expect(recording.key).toBe(key);
    expect(recorded?.events.map((event) => event.type)).toContain('harness:session_start');
    expect(recorded?.events.at(-1)?.type).toBe('harness:session_end');
    expect(JSON.stringify(recorded?.raw)).toContain('tool_result');
    expect(JSON.stringify(recorded?.raw)).toContain('ran in $REPO');
    expect(recorded?.result).toMatchObject({
      outcome: 'done',
      output: answerOf(key)?.output,
      sessionId: `cc-session-${index + 1}`,
    });
    expect(recorded?.result.usage.costUsd).toBeGreaterThan(0);
    const produced = Object.keys(answerOf(key)?.files ?? {}).sort();
    expect(
      Object.keys(recorded?.files ?? {})
        .filter((name) => produced.includes(name))
        .sort(),
    ).toEqual(produced);
  }
});

test('no form of the token and no temp path is left in any recorded byte', async () => {
  const { record } = await scenario();
  const bytes = Object.values(record.files).join('\n');
  const forms = [
    TOKEN,
    encodeURIComponent(TOKEN),
    Buffer.from(TOKEN).toString('base64'),
    Buffer.from(TOKEN).toString('base64').replace(/=+$/, ''),
  ];
  for (const form of forms) expect(bytes).not.toContain(form);
  expect(bytes).toContain('[redacted]');
  expect(bytes).not.toContain(record.repoDir);
  expect(bytes).not.toContain(record.realDir);
  expect(bytes).toContain('$REPO');
});

test('recording changes no run file: the recorded run has the unrecorded run keys, outcomes, outputs and files', async () => {
  const { recordedRun, plain } = await scenario();
  expect(recordedRun.map(({ key, outcome }) => `${key} ${outcome}`)).toContain('describe#1 done');
  expect(recordedRun).toEqual(plain);
});

test('playing the recording back, with no credential, gives the same keys, outcomes, outputs and produced files', async () => {
  const { playback, recordedRun } = await scenario();
  expect({ code: playback.code, stderr: playback.stderr }).toEqual({ code: 0, stderr: '' });
  expect(playback.journal).toEqual(recordedRun);
});

test('--record with --dry-run is refused with exit 3, and the directory is not made', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const ended = await runCaptured(['FAKE-1', '--record', 'rec', '--dry-run'], repo.dir, { env: repo.env });
    expect(ended.code).toBe(EXIT_REFUSED);
    expect(ended.stderr).toContain("--record and --dry-run can't be combined");
    expect(existsSync(join(repo.dir, 'rec'))).toBe(false);
  });
});

test('--record is listed in the usage', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toMatch(/^ {2}--record <dir> {2,}\S/m);
});

test('sail resume --record keeps spec#1.json from the suspended run, records the rest and rewrites journal.txt', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const streams = streamsFor(repo.dir);
    writeScriptedClaudeCode(repo.dir, streams);
    const env = { ...repo.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
    const first = await runCaptured(['FAKE-1', '--until', 'spec', '-q', '--record', 'rec'], repo.dir, { env });
    expect(first.code).toBe(EXIT_SUSPENDED);
    const rec = join(repo.dir, 'rec');
    const afterFirst = filesOf(rec);
    expect(Object.keys(afterFirst).sort()).toEqual(['journal.txt', 'spec#1.json']);
    const runDir = runDirIn(repo.dir);
    const runId = runDir.split('/').at(-1) ?? '';

    // The resumed process builds its harness afresh, so the streams it plays are the rest of the run's.
    writeScriptedStreams(repo.dir, streams.slice(1));
    // Bun can't reload a run's modules, so the resume runs from a copy, as a new process would, into the same directory.
    const resumed = await withTempRepo(async (copy) => {
      copyRun(repo.dir, copy.dir);
      const ended = await runCaptured(['resume', runId, '-q', '--record', rec], copy.dir, {
        env: { ...copy.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      });
      return { ...ended, journal: journalLines(join(copy.dir, '.sail-runs', runId)) };
    });
    expect({ code: resumed.code, stderr: resumed.stderr }).toEqual({ code: 0, stderr: '' });
    const after = filesOf(rec);
    expect(Object.keys(after).sort()).toEqual([...KEYS.map((key) => `${key}.json`), 'journal.txt'].sort());
    expect(after['spec#1.json']).toBe(afterFirst['spec#1.json']);
    expect(after['journal.txt']).toBe(resumed.journal);
  });
});
