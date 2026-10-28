// `sail port jev ask`, in process through run(): the configured Jev asked from a temporary repository that holds a copy
// of the fixture's `.sail/` with `jev: { use: fake }` added. The question set goes in as a JSON body, from stdin or
// --body-file, and the typed answers come out as one line of JSON.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { JevAnswered } from '../../src/ports/types';
import { copyFixture, edit, write } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';
import { THREE_QUESTIONS } from '../ports/jev.suite';

const USAGE = '       sail port jev ask [--model <id>] [--body-file <path>]\n';
const BODY = JSON.stringify(THREE_QUESTIONS);

/** The repository's `.sail/` with the jev port on the fake, seeded with `seed` when it is given. */
function withJev(repo: TempRepo, seed?: object, jev = '{ use: fake }'): string {
  const sail = copyFixture(repo.dir);
  edit(sail, 'project.yaml', '  workspace: { use: fake }\n', `  workspace: { use: fake }\n  jev: ${jev}\n`);
  if (seed !== undefined) write(sail, 'fake/jev.json', JSON.stringify(seed));
  return sail;
}

/** `sail port jev <args>` from the repository, in its environment plus `env`. */
function jev(repo: TempRepo, args: string[], options: { env?: Record<string, string>; stdin?: string } = {}) {
  return runCaptured(['port', 'jev', ...args], repo.dir, {
    env: { ...repo.env, ...options.env },
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  });
}

const appended = (file: string): Record<string, unknown>[] =>
  (existsSync(file) ? readFileSync(file, 'utf8') : '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));

test('ask answers a choice, a score and a noul question on stdout as one line of JSON, each answer of its own type', async () => {
  await withTempRepo(async (repo) => {
    withJev(repo);
    const { code, stdout, stderr } = await jev(repo, ['ask'], { stdin: BODY });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(stdout.split('\n')).toHaveLength(2);
    const printed = JSON.parse(stdout);
    expect(JevAnswered.safeParse(printed).success).toBe(true);
    expect(Object.entries(printed.answers).map(([name, answer]) => [name, (answer as { type: string }).type])).toEqual([
      ['area', 'choice'],
      ['size', 'score'],
      ['clear', 'noul'],
    ]);
  });
});

test('ask reads its body from --body-file, and --model is the model asked', async () => {
  await withTempRepo(async (repo) => {
    withJev(repo);
    const file = join(repo.dir, 'questions.json');
    writeFileSync(file, BODY);
    const { code, stdout } = await jev(repo, ['ask', '--model', 'jev-x', '--body-file', file]);
    expect({ code, model: JSON.parse(stdout).model }).toEqual({ code: EXIT_OK, model: 'jev-x' });
  });
});

test("--model overrides the body's model, and without it the body's model is the model asked", async () => {
  await withTempRepo(async (repo) => {
    withJev(repo);
    const stdin = JSON.stringify({ ...THREE_QUESTIONS, model: 'jev-body' });
    const overridden = await jev(repo, ['ask', '--model', 'jev-x'], { stdin });
    const own = await jev(repo, ['ask'], { stdin });
    expect([JSON.parse(overridden.stdout).model, JSON.parse(own.stdout).model]).toEqual(['jev-x', 'jev-body']);
  });
});

test('with SAIL_EVENTS set, ask appends a jev:asked line', async () => {
  await withTempRepo(async (repo) => {
    withJev(repo, { usage: { inputTokens: 5, outputTokens: 1 } });
    const file = join(repo.dir, 'port-events.ndjson');
    await jev(repo, ['ask'], { env: { SAIL_EVENTS: file }, stdin: BODY });
    expect(appended(file)).toEqual([
      {
        type: 'jev:asked',
        model: 'jev-latest',
        questions: 3,
        latencyMs: expect.any(Number),
        usage: { inputTokens: 5, outputTokens: 1 },
      },
    ]);
  });
});

test('an answer of 429 exits 1 with the status on stderr, and leaves an error:port of the jev port', async () => {
  await withTempRepo(async (repo) => {
    withJev(repo, { error: { status: 429, detail: 'slow down' } });
    const file = join(repo.dir, 'port-events.ndjson');
    const { code, stdout, stderr } = await jev(repo, ['ask'], { env: { SAIL_EVENTS: file }, stdin: BODY });
    expect({ code, stdout }).toEqual({ code: EXIT_FAILED, stdout: '' });
    expect(stderr).toContain('429');
    expect(appended(file)).toEqual([
      {
        type: 'error:port',
        port: 'jev',
        op: 'ask',
        code: 'unavailable',
        message: 'jev.ask: TypeSafe answered 429 Too Many Requests: slow down',
      },
    ]);
  });
});

test.each([
  ['a body that is no JSON', 'not json', 'jev ask needs a JSON body: '],
  [
    'a body that breaks the request shape',
    '{"state":"x","questions":{}}',
    'jev ask body breaks its shape at questions: ',
  ],
])('%s is refused with exit 3 before the adapter is called', async (_, stdin, message) => {
  await withTempRepo(async (repo) => {
    withJev(repo, { error: { status: 500, detail: 'must not be reached' } });
    const file = join(repo.dir, 'port-events.ndjson');
    const { code, stdout, stderr } = await jev(repo, ['ask'], { env: { SAIL_EVENTS: file }, stdin });
    expect({ code, stdout, refused: stderr.startsWith(`sail port: ${message}`) }).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      refused: true,
    });
    expect(stderr).not.toContain('must not be reached');
    expect(appended(file)).toEqual([]);
  });
});

test('an empty body is refused with exit 3', async () => {
  await withTempRepo(async (repo) => {
    withJev(repo);
    const { code, stderr } = await jev(repo, ['ask'], { stdin: '' });
    expect([code, stderr]).toEqual([EXIT_REFUSED, 'sail port: jev ask needs a body, and stdin is empty\n']);
  });
});

test('an argument ask does not take is a usage error showing the jev line', async () => {
  await withTempRepo(async (repo) => {
    withJev(repo);
    const { code, stderr } = await jev(repo, ['ask', 'extra'], { stdin: BODY });
    expect(code).toBe(EXIT_REFUSED);
    expect(stderr).toContain("unknown argument 'extra'");
    expect(stderr).toContain(USAGE);
  });
});

test('without adapters.jev the command exits 3 naming /adapters/jev', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const { code, stderr } = await jev(repo, ['ask'], { stdin: BODY });
    expect(code).toBe(EXIT_REFUSED);
    expect(stderr).toContain('/adapters/jev');
    expect(stderr).toContain('is not set');
  });
});

test('jev: { use: typesafe } without TYPESAFE_API_KEY exits 3 naming it, and asks nothing', async () => {
  await withTempRepo(async (repo) => {
    withJev(repo, undefined, '{ use: typesafe }');
    const { code, stdout, stderr } = await jev(repo, ['ask'], { env: { TYPESAFE_API_KEY: '' }, stdin: BODY });
    expect({ code, stdout }).toEqual({ code: EXIT_REFUSED, stdout: '' });
    expect(stderr).toContain('needs TYPESAFE_API_KEY, which is not set');
  });
});
