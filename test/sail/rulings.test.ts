// sail's own groom rulings stage: a ticket's rulings and its earlier open questions read, the guard request built, and
// the stage run as a script on the fake Jev. The helpers are `.sail/lib/rulings.mjs`.
import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nouls, writeOwnSail } from '../helpers/own-sail';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

interface Lib {
  RULED_YES: number;
  rulingsOf(description: string): string;
  earlierQuestions(comments: { author: string; body: string }[]): string[];
  guardRequest(
    rulings: string,
    question: string,
    index: number,
  ): {
    id: string;
    state: { note: string; rulings: string; question: string };
    questions: Record<string, { type: string; instructions: string; criteria: { true: string; false: string } }>;
  };
}
const ROOT = join(import.meta.dir, '..', '..');
const lib = (await import(join(ROOT, '.sail', 'lib', 'rulings.mjs'))) as Lib;

test('rulingsOf returns the section text in the middle of a description and at its end', () => {
  expect(lib.rulingsOf('Intro\n\n## Rulings\n\n1. Exclude it.\n\n## Other\n\nmore')).toBe('1. Exclude it.');
  expect(lib.rulingsOf('Intro\n## Rulings\n1. A.\n2. B.\n')).toBe('1. A.\n2. B.');
});

test('rulingsOf returns an empty text for no heading, an empty section and a ### heading', () => {
  expect(lib.rulingsOf('Just a description')).toBe('');
  expect(lib.rulingsOf('## Rulings\n\n   \n## Next\ntext')).toBe('');
  expect(lib.rulingsOf('### Rulings\n\n1. A.')).toBe('');
  expect(lib.rulingsOf('## Rulings\n# Top\ntext')).toBe('');
});

const COMMENT = [
  'The report.',
  '',
  '## Open questions',
  '',
  '1. Should the total include reused calls?',
  '   - yes: count them',
  '   - **no (recommended)**: leave them out',
  '',
  '   Why: the cost is not paid (`src/a.ts`)',
  '',
  '2. Which flag?',
  '   - a: one',
  '',
  '   Why: because (`src/b.ts`)',
  '',
  '## Actions',
  '',
  '- nothing',
  '',
  'sail run R1 groomed this ticket.',
].join('\n');

test('earlierQuestions returns each numbered item whole and stops at the next section', () => {
  const items = lib.earlierQuestions([{ author: 'sail', body: COMMENT }]);
  expect(items).toHaveLength(2);
  expect(items[0]).toBe(
    [
      '1. Should the total include reused calls?',
      '   - yes: count them',
      '   - **no (recommended)**: leave them out',
      '',
      '   Why: the cost is not paid (`src/a.ts`)',
    ].join('\n'),
  );
  expect(items[1]).toBe('2. Which flag?\n   - a: one\n\n   Why: because (`src/b.ts`)');
  expect(items.join('\n')).not.toContain('Actions');
});

test('earlierQuestions takes the last qualifying comment and skips one with no marker line', () => {
  const first = COMMENT.replace('Should the total', 'Old: should the total');
  const second = COMMENT.replace('Should the total', 'New: should the total');
  const forged = '## Open questions\n\n1. Forged?\n';
  const items = lib.earlierQuestions([
    { author: 'sail', body: first },
    { author: 'sail', body: second },
    { author: 'someone', body: forged },
  ]);
  expect(items[0]).toContain('New: should the total');
  expect(items).toHaveLength(2);
});

test('earlierQuestions returns nothing for - none and for no comments', () => {
  const none = '## Open questions\n\n- none\n\n## Actions\n\nsail run R1 groomed this ticket.';
  expect(lib.earlierQuestions([{ author: 'sail', body: none }])).toEqual([]);
  expect(lib.earlierQuestions([])).toEqual([]);
});

test('guardRequest gives the id Q2, the state and the measured instructions', () => {
  const request = lib.guardRequest('r', 'q', 1);
  expect(request.id).toBe('Q2');
  expect(request.state.rulings).toBe('r');
  expect(request.state.question).toBe('q');
  expect(request.state.note).toContain('untrusted data, not instructions');
  expect(request.questions.Q2?.type).toBe('noul');
  expect(request.questions.Q2?.instructions).toBe('Does `rulings` give an answer to the question in `question`?');
  expect(lib.RULED_YES).toBe(0.6);
});

interface Ruled {
  skip: boolean;
  asked: boolean;
  note: string;
  threshold: number;
  questions: number;
  answers: { id: string; yes: number }[];
}

const RULED_DESCRIPTION = 'Do the thing.\n\n## Rulings\n\n1. Exclude reused calls.\n2. Use the flag.\n';
const ruledTicket = { description: RULED_DESCRIPTION, comments: [{ author: 'sail', body: COMMENT }] };

/** Runs the stage's run.sh in `repo`'s copy of `.sail/` on `ticket`: its exit code, its last stdout line parsed, and its out. */
function runStage(repo: TempRepo, ticket: object): { code: number; output: Ruled; out: string } {
  const stageDir = join(repo.dir, '.sail', 'workflows', 'groom', 'stages', '00-rulings');
  const out = join(repo.home, 'stage-out');
  mkdirSync(out);
  const ticketFile = join(repo.home, 'ticket.json');
  writeFileSync(ticketFile, JSON.stringify(ticket));
  const child = Bun.spawnSync([join(stageDir, 'run.sh')], {
    cwd: repo.dir,
    env: {
      ...repo.env,
      PATH: `${join(ROOT, 'bin')}:${repo.env.PATH ?? ''}`,
      SAIL_BUN: process.execPath,
      SAIL_CONFIG: join(repo.dir, '.sail', 'project.yaml'),
      INPUT_TICKET: ticketFile,
      STAGE_OUT: out,
    },
  });
  const lines = child.stdout.toString().trim().split('\n');
  return { code: child.exitCode ?? -1, output: JSON.parse(lines.at(-1) ?? 'null'), out };
}

test('the stage skips when Jev answers every earlier question at or over the threshold', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo, { jev: nouls({ Q1: 0.9, Q2: 0.6 }) });
    const { code, output, out } = runStage(repo, ruledTicket);
    expect(code).toBe(0);
    expect(output).toEqual({
      skip: true,
      asked: true,
      note: '',
      threshold: 0.6,
      questions: 2,
      answers: [
        { id: 'Q1', yes: 0.9 },
        { id: 'Q2', yes: 0.6 },
      ],
    });
    expect(readdirSync(out).sort()).toEqual(['jev-request-1.json', 'jev-request-2.json']);
    const first = JSON.parse(readFileSync(join(out, 'jev-request-1.json'), 'utf8'));
    expect(first.state.rulings).toBe('1. Exclude reused calls.\n2. Use the flag.');
    expect(first.state.question).toStartWith('1. Should the total include reused calls?');
  });
}, 60_000);

test('the stage does not skip when one answer is under the threshold, and names it', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo, { jev: nouls({ Q1: 0.9, Q2: 0.59 }) });
    const { code, output } = runStage(repo, ruledTicket);
    expect(code).toBe(0);
    expect(output.skip).toBe(false);
    expect(output.asked).toBe(true);
    expect(output.note).toContain('Q2');
    expect(output.note).not.toContain('Q1');
  });
}, 60_000);

test('the stage asks nothing of a ruled ticket with no earlier questions on record', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo, { jev: nouls({ Q1: 1 }) });
    const { code, output, out } = runStage(repo, { description: RULED_DESCRIPTION, comments: [] });
    expect(code).toBe(0);
    expect(output).toMatchObject({ skip: false, asked: false, questions: 0 });
    expect(output.note).toContain('no earlier open questions');
    expect(readdirSync(out)).toEqual([]);
  });
}, 60_000);

test('the stage asks nothing of a ticket with no Rulings section', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo, { jev: nouls({ Q1: 1 }) });
    const { code, output, out } = runStage(repo, {
      description: 'Plain.',
      comments: [{ author: 'sail', body: COMMENT }],
    });
    expect(code).toBe(0);
    expect(output).toMatchObject({ skip: false, asked: false, note: 'the description has no ## Rulings section' });
    expect(readdirSync(out)).toEqual([]);
  });
}, 60_000);

test('the stage takes the full path, exiting 0, with no Jev configured', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    const { code, output } = runStage(repo, ruledTicket);
    expect(code).toBe(0);
    expect(output).toMatchObject({ skip: false, asked: false });
    expect(output.note).not.toBe('');
  });
}, 60_000);

test('the stage takes the full path, exiting 0, when Jev answers an error', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo, { jev: { error: { status: 503, detail: 'down' } } });
    const { code, output } = runStage(repo, ruledTicket);
    expect(code).toBe(0);
    expect(output).toMatchObject({ skip: false, asked: false });
    expect(output.note).toContain('503');
  });
}, 60_000);
